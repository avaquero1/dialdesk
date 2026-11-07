/**
 * The real connections, end to end over HTTP, against the mock exchange (recorded answers, real signature checks).
 * Every request and answer is checked against the contract (runCase). No network, no real key.
 */
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTIONS, TRUST_ACTIONS } from '@app/contracts';
import { buildApp, MemoryBus } from '@app/service-kit';
import { runCase, testCallers, type Case } from '@app/testkit';
import { createFakeAudit } from '../../audit/src/fake.ts';
import { createConnections } from '../src/real.ts';
import { seal, sealAad } from '../src/seal.ts';
import { MemoryStore } from '../src/store.ts';
import { mockExchange } from './mock-exchange.ts';

const ACC = 'acc_test0001';
const ACC2 = 'acc_test0002';
const READ_ID = 'a1b2c3d4-0000-4000-8000-00000000read';
const TRADE_ID = 'a1b2c3d4-0000-4000-8000-0000000trade';
const WTRD_ID = 'a1b2c3d4-0000-4000-8000-00000000wtrd';
const RSA_ID = 'a1b2c3d4-0000-4000-8000-000000000rsa';
const UNKNOWN_ID = 'a1b2c3d4-0000-4000-8000-00000unknown';
const WALLET = '0x00000000000000000000000000000000000f1A7e';

const pemOf = (k: KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }) as string;
const edRead = generateKeyPairSync('ed25519').privateKey;
const edTrade = generateKeyPairSync('ed25519').privateKey;
const edWtrd = generateKeyPairSync('ed25519').privateKey;
const rsaRead = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const edUnknown = generateKeyPairSync('ed25519').privateKey;
const PEMS: string[] = [edRead, edTrade, edWtrd, rsaRead, edUnknown].map(pemOf);
const [PEM_READ, PEM_TRADE, PEM_WTRD, PEM_RSA, PEM_UNKNOWN] = PEMS as [string, string, string, string, string];

const ex = mockExchange();
ex.addKey(READ_ID, edRead, 'kalshi-api_keys-read.json');
ex.addKey(TRADE_ID, edTrade, 'kalshi-api_keys-write.json');
ex.addKey(WTRD_ID, edWtrd, 'kalshi-api_keys-write-trade.json');
ex.addKey(RSA_ID, rsaRead, 'kalshi-api_keys-rsa-read.json');

const bus = new MemoryBus();
const store = new MemoryStore();
const logLines: string[] = [];
const enqueued: string[] = [];
let conns: Awaited<ReturnType<typeof createConnections>>;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  const log = pino({ level: 'debug' }, { write: (s: string) => void logLines.push(s) });
  conns = await createConnections(
    { KALSHI_ENVS: 'demo', TIMEOUT_MS: '5000' },
    { master: randomBytes(32), fetch: ex.fetch, bus, store, log, enqueueRefresh: async (id) => void enqueued.push(id) },
  );
  app = buildApp({ service: 'connections', mode: 'real', api: CONNECTIONS, handlers: conns.handlers, callers: testCallers(), log });
});
afterAll(() => conns.close());

const kalshi = (key_id: string, sealed_key: unknown, more: Record<string, unknown> = {}) => ({
  body: { account_id: ACC, exchange: 'kalshi', key_id, key_type: 'ed25519', sealed_key, env: 'demo', ...more },
});
const cid = (c: Record<string, unknown>, k: string) => (c[k] as { connection_id: string }).connection_id;
const sealFor = (pem: string, key_id: string, account = ACC) => async (c: Record<string, unknown>) => {
  c.sealed = await seal(String(c.pub), pem, sealAad(account, key_id));
};

describe('connections real mode: connect, consent, numbers', () => {
  const cases: Case[] = [
    { endpoint: 'publicKey', caller: 'edge', save: (o, c) => (c.pub = o.public_key) },
    // a read-only key is accepted
    {
      endpoint: 'connect',
      caller: 'edge',
      before: sealFor(PEM_READ, READ_ID),
      input: (c) => kalshi(READ_ID, c.sealed),
      save: (o, c) => (c.read = o),
      label: 'read-only Ed25519 key accepted',
    },
    // keys that can trade are refused
    { endpoint: 'connect', caller: 'edge', before: sealFor(PEM_TRADE, TRADE_ID), input: (c) => kalshi(TRADE_ID, c.sealed), expect: 403, label: 'read+write key refused' },
    { endpoint: 'connect', caller: 'edge', before: sealFor(PEM_WTRD, WTRD_ID), input: (c) => kalshi(WTRD_ID, c.sealed), expect: 403, label: 'write::trade key refused' },
    // public demo default: prod keys are refused before anything is opened or called
    { endpoint: 'connect', caller: 'edge', before: sealFor(PEM_READ, READ_ID), input: (c) => kalshi(READ_ID, c.sealed, { env: 'prod' }), expect: 403, label: 'prod refused by default' },
    // a key sealed for another account (replayed body) doesn't open
    { endpoint: 'connect', caller: 'edge', before: sealFor(PEM_READ, READ_ID, ACC2), input: (c) => kalshi(READ_ID, c.sealed), expect: 400, label: 'replayed seal refused' },
    // the key type the user picked must match the PEM
    { endpoint: 'connect', caller: 'edge', before: sealFor(PEM_READ, READ_ID), input: (c) => kalshi(READ_ID, c.sealed, { key_type: 'rsa' }), expect: 422, label: 'wrong key type' },
    // a read-only RSA key (RSA-PSS signatures) is accepted too
    { endpoint: 'connect', caller: 'edge', before: sealFor(PEM_RSA, RSA_ID), input: (c) => kalshi(RSA_ID, c.sealed, { key_type: 'rsa' }), save: (o, c) => (c.rsa = o), label: 'read-only RSA key accepted' },
    // a key Kalshi doesn't know: its signature is refused (401) → 422
    { endpoint: 'connect', caller: 'edge', before: sealFor(PEM_UNKNOWN, UNKNOWN_ID), input: (c) => kalshi(UNKNOWN_ID, c.sealed), expect: 422, label: 'unknown key rejected' },
    { endpoint: 'connect', caller: 'edge', input: () => ({ body: { account_id: ACC, exchange: 'polymarket', wallet: WALLET } }), save: (o, c) => (c.poly = o), label: 'polymarket wallet' },
    { endpoint: 'list', caller: 'edge', input: () => ({ query: { account_id: ACC } }), save: (o, c) => (c.list = o) },
    { endpoint: 'list', caller: 'edge', input: () => ({ query: { account_id: ACC2 } }), save: (o, c) => (c.list2 = o), label: 'another account sees none' },
    { endpoint: 'numbers', caller: 'runner', input: (c) => ({ params: { connection_id: cid(c, 'read') }, query: { account_id: ACC } }), expect: 403, label: 'no consent yet' },
    { endpoint: 'setConsent', caller: 'edge', input: (c) => ({ params: { connection_id: cid(c, 'read') }, body: { account_id: ACC2, share_numbers: true } }), expect: 404, label: "not another account's" },
    { endpoint: 'setConsent', caller: 'edge', input: (c) => ({ params: { connection_id: cid(c, 'read') }, body: { account_id: ACC, share_numbers: true } }) },
    { endpoint: 'numbers', caller: 'runner', input: (c) => ({ params: { connection_id: cid(c, 'read') }, query: { account_id: ACC2 } }), expect: 404, label: 'wrong account' },
    { endpoint: 'numbers', caller: 'runner', input: (c) => ({ params: { connection_id: cid(c, 'read') }, query: { account_id: ACC } }), save: (o, c) => (c.kn = o), label: 'kalshi numbers' },
    { endpoint: 'setConsent', caller: 'edge', input: (c) => ({ params: { connection_id: cid(c, 'poly') }, body: { account_id: ACC, share_numbers: true } }) },
    { endpoint: 'numbers', caller: 'runner', input: (c) => ({ params: { connection_id: cid(c, 'poly') }, query: { account_id: ACC } }), save: (o, c) => (c.pn = o), label: 'polymarket numbers' },
    { endpoint: 'setConsent', caller: 'edge', input: (c) => ({ params: { connection_id: cid(c, 'read') }, body: { account_id: ACC, share_numbers: false } }), label: 'consent withdrawn' },
    { endpoint: 'numbers', caller: 'runner', input: (c) => ({ params: { connection_id: cid(c, 'read') }, query: { account_id: ACC } }), expect: 403, label: 'withdrawn: refused again' },
    { endpoint: 'remove', caller: 'edge', input: (c) => ({ params: { connection_id: cid(c, 'poly') }, query: { account_id: ACC } }) },
    { endpoint: 'remove', caller: 'edge', input: (c) => ({ params: { connection_id: cid(c, 'poly') }, query: { account_id: ACC } }), expect: 404, label: 'gone' },
  ];
  const ctx: Record<string, any> = {};
  for (const [i, c] of cases.entries())
    it(`${i + 1}. ${c.endpoint}${c.label ? ` (${c.label})` : ''} as ${c.caller}`, async () => {
      const out = await runCase(app, CONNECTIONS, c, ctx);
      expect(out.problems).toEqual([]);
    });

  it('the read-only key is stored as verified; refused keys are not stored at all', () => {
    expect(ctx.read).toMatchObject({ exchange: 'kalshi', label: READ_ID, scope: 'read', scope_verified: true, share_numbers: false, public_data: false });
    expect(ctx.rsa).toMatchObject({ exchange: 'kalshi', scope_verified: true });
    expect(ctx.list.connections.map((c: any) => c.exchange)).toEqual(['kalshi', 'kalshi', 'polymarket']);
    expect(ctx.list2.connections).toEqual([]);
    expect(ctx.poly).toMatchObject({ public_data: true, label: '0x0000…1a7e' });
  });

  it('only numbers come out: Kalshi balance and positions', () => {
    expect(ctx.kn.balance_cents).toBe(124018);
    expect(ctx.kn.positions).toEqual([
      { market_id: 'kalshi:KXNFLGAME-26NOV08KCBUF-KC', side: 'yes', count: 40, avg_price_cents: 55 },
      { market_id: 'kalshi:KXNFLGAME-26NOV08GBCHI-GB', side: 'no', count: 25, avg_price_cents: 44 },
      { market_id: 'kalshi:KXNBAGAME-26NOV07DENPHX-DEN', side: 'yes', count: 30, avg_price_cents: 57 },
    ]);
    expect(Object.keys(ctx.kn).sort()).toEqual(['as_of', 'balance_cents', 'connection_id', 'positions']);
  });

  it('Polymarket v2 positions parse into numbers (Yes/No, a named binary outcome, unlabelled skipped)', () => {
    expect(ctx.pn.balance_cents).toBeNull();
    expect(ctx.pn.positions).toEqual([
      { market_id: 'polymarket:nfl-kc-buf-2026-11-08', side: 'yes', count: 120, avg_price_cents: 55 },
      { market_id: 'polymarket:nba-lal-bos-2026-11-07', side: 'no', count: 80, avg_price_cents: 50 },
      { market_id: 'polymarket:nba-den-phx-2026-11-07', side: 'yes', count: 50, avg_price_cents: 41 },
    ]);
    const call = ex.calls.find((c) => c.url.startsWith('https://data-api.polymarket.com/'))!;
    expect(new URL(call.url).pathname).toBe('/v2/positions');
    expect(new URL(call.url).searchParams.get('user')).toBe(WALLET.toLowerCase());
  });

  it('the exchange only ever saw GETs, and the refused prod key never reached it', () => {
    expect(ex.calls.length).toBeGreaterThan(0);
    expect(ex.calls.every((c) => c.method === 'GET' && !c.hasBody)).toBe(true);
    expect(ex.calls.some((c) => c.url.includes('external-api.kalshi.com'))).toBe(false);
  });

  it('consent queued an account-refresh job; the stored key is ciphertext', async () => {
    expect(enqueued).toContain(ctx.read.connection_id);
    const row = (await store.get(ctx.read.connection_id))!;
    expect(row.scopes).toEqual(['read']);
    expect(row.key_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.key_blob!.toString('latin1')).not.toContain('PRIVATE KEY');
  });

  it('audit got the checks with key ids and fingerprints, never a key, a PEM or a sealed body', () => {
    const checks = bus.entries.filter((e) => e.action === TRUST_ACTIONS.connectionChecked);
    expect(checks.map((e) => [e.ids.exchange, e.outcome, e.ids.scope ?? '-', e.ids.reason ?? 'ok'])).toEqual([
      ['kalshi', 'ok', 'read', 'ok'],
      ['kalshi', 'refused', 'read,write', 'write_scope'],
      ['kalshi', 'refused', 'read,write::trade', 'write_scope'],
      ['kalshi', 'refused', '-', 'env_not_allowed'],
      ['kalshi', 'ok', 'read', 'ok'],
      ['kalshi', 'failed', '-', 'kalshi_401'],
      ['polymarket', 'ok', 'read', 'ok'],
    ]);
    expect(checks[0]!.hashes.key).toMatch(/^[0-9a-f]{64}$/);
    expect(bus.entries.filter((e) => e.action.startsWith(TRUST_ACTIONS.consentPrefix)).map((e) => e.action)).toEqual([
      'consent.numbers_shared',
      'consent.numbers_shared',
      'consent.numbers_withdrawn',
    ]);
    const all = JSON.stringify(bus.entries) + logLines.join('');
    expect(all).not.toContain('PRIVATE KEY');
    for (const pem of PEMS) expect(all).not.toContain(pem.split('\n')[1]!.slice(0, 24));
    expect(all).not.toContain(ctx.sealed.slice(0, 24));
  });
});

describe("connections' log on audit's trust page", () => {
  it('shows the connected accounts with their scope, and drops a removed one', async () => {
    const a = createFakeAudit();
    for (const e of bus.entries) a.append(e);
    const t = (await a.handlers.trust({ query: { account_id: ACC } } as never, {} as never)) as { connected: { exchange: string; scope: string }[]; consents: unknown[] };
    // read-only Ed25519 and RSA keys are listed; the Polymarket wallet was removed; refused keys never appear
    expect(t.connected.map((c) => [c.exchange, c.scope])).toEqual([
      ['kalshi', 'read'],
      ['kalshi', 'read'],
    ]);
    expect(t.consents).toHaveLength(3);
  });
});

describe('connections real mode: refresh', () => {
  it('a refresh reads only shared connections, through GET', async () => {
    const before = ex.calls.length;
    const id = (await store.byAccount(ACC))[0]!.conn.connection_id; // consent was withdrawn above
    expect(await conns.refresh(id)).toBeNull();
    expect(ex.calls.length).toBe(before);
  });

  it('a rejected key fails its job without a retry; 5xx is left to the retry rules', async () => {
    const id = (await store.byAccount(ACC))[0]!.conn.connection_id;
    await store.setConsent(id, true);
    ex.forceStatus('/trade-api/v2/portfolio/balance', 401);
    await expect(conns.refreshJob(id)).rejects.toMatchObject({ name: 'NoRetry', reason: 'kalshi_401' });
    ex.forceStatus('/trade-api/v2/portfolio/balance', 503);
    await expect(conns.refreshJob(id)).rejects.toMatchObject({ name: 'KalshiError', kind: 'retryable' });
  });
});

describe('connections real mode: start-up', () => {
  it('refuses to start without a master key file', async () => {
    await expect(createConnections({ MASTER_KEY_FILE: '/nonexistent/connections-master' }, { bus: null, enqueueRefresh: null })).rejects.toThrow();
  });
  it('refuses an unknown Kalshi env', async () => {
    await expect(createConnections({ KALSHI_ENVS: 'demo,live' }, { master: randomBytes(32), bus: null, enqueueRefresh: null })).rejects.toThrow(/KALSHI_ENVS/);
  });
});
