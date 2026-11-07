/**
 * A stand-in for Kalshi and Polymarket that replays test/recorded/*.json. It checks every Kalshi request the way
 * Kalshi's docs describe: the three KALSHI-ACCESS-* headers, a fresh timestamp, and a signature over
 * timestamp + method + path (no query) that verifies with the key's public half. A bad signature answers 401.
 * Every request, whatever its method, is kept in `calls`, so a test can prove nothing but GET ever arrived.
 */
import { constants, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./recorded/', import.meta.url));
export const recorded = (name: string) => JSON.parse(readFileSync(dir + name, 'utf8'));

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  hasBody: boolean;
}

export function mockExchange() {
  const calls: Call[] = [];
  const keys = new Map<string, KeyObject>();
  /** Which recorded GET /api_keys answer a key id gets. */
  const apiKeysFile = new Map<string, string>();
  const status = new Map<string, number>();

  const json = (body: unknown, s = 200) => new Response(JSON.stringify(body), { status: s, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url: url.href, headers, hasBody: init.body != null });
    const forced = status.get(url.pathname);
    if (forced) return json({ error: 'forced' }, forced);

    if (url.hostname === 'data-api.polymarket.com') return json(recorded('polymarket-v2-positions.json'));

    // Kalshi
    const keyId = headers['kalshi-access-key'];
    const ts = headers['kalshi-access-timestamp'];
    const sig = headers['kalshi-access-signature'];
    const key = keyId ? keys.get(keyId) : undefined;
    if (!key || !ts || !sig || Math.abs(Date.now() - Number(ts)) > 30_000) return json({ error: 'unauthorized' }, 401);
    const msg = Buffer.from(ts + method + url.pathname);
    const ok =
      key.asymmetricKeyType === 'ed25519'
        ? verify(null, msg, key, Buffer.from(sig, 'base64'))
        : verify('sha256', msg, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(sig, 'base64'));
    if (!ok) return json({ error: 'bad signature' }, 401);
    const path = url.pathname.replace(/^\/trade-api\/v2/, '');
    if (path === '/api_keys') return json(recorded(apiKeysFile.get(keyId!) ?? 'kalshi-api_keys-read.json'));
    if (path === '/portfolio/balance') return json(recorded('kalshi-portfolio-balance.json'));
    if (path === '/portfolio/positions') return json(recorded('kalshi-portfolio-positions.json'));
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    /** Register a key: its public half checks signatures; `answer` is the recorded /api_keys file it gets. */
    addKey(keyId: string, privateKey: KeyObject, answer = 'kalshi-api_keys-read.json') {
      keys.set(keyId, createPublicKey(privateKey));
      apiKeysFile.set(keyId, answer);
    },
    forceStatus(pathname: string, s: number) {
      status.set(pathname, s);
    },
  };
}
