/**
 * GET-only, proven: no code path in connections can send an exchange anything but a GET to a listed path.
 * 1. The guard refuses every other method, a body, and every off-list URL, before the network is touched.
 * 2. The Kalshi and Polymarket clients send only GETs, on every call they have.
 * 3. No source file in src/ names another HTTP method or a path that trades.
 */
import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getOnlyFetch, NotAllowedRequest } from '../src/getonly.ts';
import { KALSHI_BASES, KALSHI_GET_PATHS, KALSHI_ROUTES, kalshiClient } from '../src/kalshi.ts';
import { polymarketClient, POLYMARKET_ROUTES } from '../src/polymarket.ts';
import { mockExchange } from './mock-exchange.ts';

const ALL_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', 'post', 'Delete', 'PROPFIND', 'QUERY'];
const ROUTES = [...KALSHI_ROUTES, ...POLYMARKET_ROUTES];

function spy() {
  const seen: { url: string; init: RequestInit }[] = [];
  const inner = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, send: getOnlyFetch(ROUTES, inner) };
}

describe('the GET-only guard', () => {
  for (const base of Object.values(KALSHI_BASES))
    for (const path of KALSHI_GET_PATHS)
      for (const method of ALL_METHODS)
        it(`refuses ${method} ${base}${path} and sends nothing`, async () => {
          const { seen, send } = spy();
          await expect(send(`${base}${path}`, { method } as never)).rejects.toBeInstanceOf(NotAllowedRequest);
          expect(seen).toHaveLength(0);
        });

  it('refuses a non-GET to Polymarket too', async () => {
    const { seen, send } = spy();
    for (const method of ALL_METHODS)
      await expect(send('https://data-api.polymarket.com/v2/positions?user=0x0', { method } as never)).rejects.toBeInstanceOf(NotAllowedRequest);
    expect(seen).toHaveLength(0);
  });

  it('refuses a GET with a body', async () => {
    const { seen, send } = spy();
    await expect(send(`${KALSHI_BASES.demo}/api_keys`, { body: '{}' } as never)).rejects.toBeInstanceOf(NotAllowedRequest);
    expect(seen).toHaveLength(0);
  });

  it('refuses paths that are not on the list: orders, transfers, another host, credentials in the URL', async () => {
    const { seen, send } = spy();
    for (const url of [
      `${KALSHI_BASES.prod}/portfolio/orders`,
      `${KALSHI_BASES.prod}/portfolio/orders/batched`,
      `${KALSHI_BASES.demo}/portfolio/orders/abc`,
      `${KALSHI_BASES.prod}/api_keys/generate`,
      `${KALSHI_BASES.prod}/portfolio/subaccounts/transfer`,
      `${KALSHI_BASES.prod}/../v1/api_keys`,
      'https://external-api.kalshi.com/api_keys',
      'https://evil.example/trade-api/v2/api_keys',
      'http://external-api.kalshi.com/trade-api/v2/api_keys',
      'https://user:pw@external-api.kalshi.com/trade-api/v2/api_keys',
      'https://data-api.polymarket.com/positions',
      'https://clob.polymarket.com/order',
      'not a url',
    ])
      await expect(send(url)).rejects.toBeInstanceOf(NotAllowedRequest);
    expect(seen).toHaveLength(0);
  });

  it('lets a listed GET through as a GET, with redirects off', async () => {
    const { seen, send } = spy();
    await send(`${KALSHI_BASES.demo}/portfolio/positions?limit=1`);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init.method).toBe('GET');
    expect(seen[0]!.init.redirect).toBe('error');
    expect(seen[0]!.init.body).toBeUndefined();
  });

  it('the Kalshi path list holds only the three read paths', () => {
    expect([...KALSHI_GET_PATHS].sort()).toEqual(['/api_keys', '/portfolio/balance', '/portfolio/positions']);
  });
});

describe('the clients send nothing but GET', () => {
  it('Kalshi: every method of the client, on both exchanges', async () => {
    const ex = mockExchange();
    const { privateKey } = generateKeyPairSync('ed25519');
    ex.addKey('k-getonly-1', privateKey);
    for (const env of ['demo', 'prod'] as const) {
      const k = kalshiClient({ env, keyId: 'k-getonly-1', key: privateKey, fetch: ex.fetch });
      expect(Object.keys(k).sort()).toEqual(['apiKeys', 'balance', 'positions']);
      await k.apiKeys();
      await k.balance();
      await k.positions();
    }
    expect(ex.calls.length).toBe(6);
    for (const c of ex.calls) {
      expect(c.method).toBe('GET');
      expect(c.hasBody).toBe(false);
    }
  });

  it('Polymarket: positions', async () => {
    const ex = mockExchange();
    await polymarketClient({ fetch: ex.fetch }).positions('0x00000000000000000000000000000000000f1a7e');
    expect(ex.calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('the source', () => {
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('no file in src/ sets an HTTP method other than GET, or names a trading path', () => {
    for (const f of files) {
      const src = readFileSync(dir + f, 'utf8');
      expect(src, f).not.toMatch(/method:\s*['"`](?!GET['"`])/i);
      expect(src, f).not.toMatch(/['"`](POST|PUT|PATCH|DELETE)['"`]/);
      expect(src, f).not.toMatch(/\/portfolio\/orders|\/orders['"`/]|\/transfer/);
    }
  });
  it('only getonly.ts holds a raw fetch call; every client goes through it', () => {
    for (const f of files.filter((x) => x !== 'getonly.ts')) {
      const src = readFileSync(dir + f, 'utf8');
      expect(src, f).not.toMatch(/(?<![.\w])fetch\(/);
    }
  });
});
