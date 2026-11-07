/**
 * The real edge, in `make check`: the shared contract cases through the real edge and the real accounts (memory
 * store), then the door's security checks: the session round trip, forged and expired tokens, logout, Origin,
 * rate limits, the body cap, the opaque connect route, and /live over a real socket.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CONNECTIONS, EDGE, type Endpoint } from '@app/contracts';
import { createClient, createLogger, type Call, type Logger } from '@app/service-kit';
import { fakeApp, runCase, TEST_TOKENS, type Ctx } from '@app/testkit';
import { fake as connectionsFake } from '../../connections/src/fake.ts';
import { signSession, signingKeyFrom } from '../../accounts/src/session.ts';
import { realAccounts, testKey } from '../../accounts/test/helpers.ts';
import { LocalBus } from '../src/feed.ts';
import { CLOSE } from '../src/live.ts';
import { createRealEdge, type RealEdge, type RealEdgeOptions } from '../src/real.ts';
import { kidOf, sessionKeys, verifySession } from '../src/session.ts';
import { cases, wire } from './cases.ts';

const ORIGIN = 'https://vultrcontest.vaquerothe.dev';
const silent = createLogger('edge', 'silent');
const PW = 'correct horse battery';

/** The real accounts (sharing one in-process bus) and the real edge, on the other services' fakes. */
function setup(o: Partial<RealEdgeOptions> & { connections?: (c: Call) => Call } = {}) {
  const key = testKey();
  const bus = new LocalBus();
  const accounts = realAccounts({ key, bus });
  let edge!: RealEdge;
  const app = wire((deps) => {
    if (o.connections && deps.connections) deps.connections = o.connections(deps.connections);
    edge = createRealEdge({ keys: sessionKeys(key.publicKey), origins: [ORIGIN], log: silent, trustProxy: true, feed: bus, ...o, deps: { ...deps, ...o.deps } });
    return edge.app;
  }, accounts.app);
  return { app, edge, key, bus, accounts };
}

/** A browser on our page: it sends our Origin on every call, like a real one does on state-changing calls. */
function browser(app: Hono, ip = '198.51.100.7') {
  let cookie: string | null = null;
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { origin: ORIGIN, 'x-forwarded-for': ip, ...extra };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return res;
  };
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

describe('edge (real): the contract cases through the real edge and real accounts', () => {
  // Built in beforeAll, after every describe body ran: wire() points the receipt case's back door at this board.
  let app: Hono;
  beforeAll(() => {
    app = setup().app;
    const orig = app.request.bind(app);
    app.request = ((input: string, init?: RequestInit) => orig(input, { ...init, headers: { origin: ORIGIN, ...(init?.headers as Record<string, string>) } })) as typeof app.request;
  });
  const ctx: Ctx = {};
  for (const [i, c] of cases.entries())
    it(`${i + 1}. ${c.endpoint}${c.label ? ` (${c.label})` : ''} as ${c.caller}`, async () => {
      expect((await runCase(app, EDGE, c, ctx)).problems).toEqual([]);
    });

  it('serves no route outside its contract', () => {
    const declared = new Set(Object.values(EDGE).map((e: Endpoint) => `${e.method} ${e.path}`));
    const served = app.routes.map((r) => `${r.method} ${r.path}`).filter((r) => r !== 'GET /health' && !r.startsWith('ALL '));
    expect(served.filter((r) => !declared.has(r))).toEqual([]);
  });
});

describe('edge (real): the session round trip', () => {
  it('sign up sets an HttpOnly, Secure, SameSite=Strict cookie; it opens protected routes; none is 401', async () => {
    const { app } = setup();
    const b = browser(app);
    const res = await b.call('POST', '/api/signup', { email: 'kim@example.test', password: PW });
    expect(res.status).toBe(201);
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/^app_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; /);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(set).toContain(attr);
    expect(Number(/Max-Age=(\d+)/.exec(set)![1])).toBeGreaterThan(7 * 86400 - 5);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { account }: any = await res.json();

    const me = await b.call('GET', '/api/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).account_id).toBe(account.account_id);
    expect((await b.call('GET', '/api/board')).status).toBe(200);

    const anon = browser(app);
    expect((await anon.call('GET', '/api/me')).status).toBe(401);
    expect((await anon.call('GET', '/api/board')).status).toBe(401);
    expect((await anon.call('PUT', '/api/look', { theme: 'ice', mode: 'dark', hue: null })).status).toBe(401);
  });

  it('a service token is not a session: 401 on browser routes, and accounts answers 403 to a caller it does not list', async () => {
    const { app, accounts } = setup();
    expect((await app.request('/api/me', { headers: { authorization: `Bearer ${TEST_TOKENS.board}` } })).status).toBe(401);
    // accounts accepts only edge: board's valid token is a wrong caller (403), no token is 401.
    const r403 = await accounts.app.request('/accounts', { method: 'POST', headers: { authorization: `Bearer ${TEST_TOKENS.board}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.test', password: PW }) });
    expect(r403.status).toBe(403);
    const r401 = await accounts.app.request('/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r401.status).toBe(401);
  });

  it('refuses forged, altered, foreign-key, alg-none and expired tokens', async () => {
    let t = Date.now();
    const { app, key } = setup({ clock: () => t });
    const b = browser(app);
    await b.call('POST', '/api/signup', { email: 'ana@example.test', password: PW });
    const token = b.cookie!.slice('app_session='.length);
    const [h, p, s] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const other = signingKeyFrom(generateKeyPairSync('ed25519').privateKey);
    const forged = (head: unknown, body: unknown, k = other) => {
      const input = `${enc(head)}.${enc(body)}`;
      return `${input}.${sign(null, Buffer.from(input), k.privateKey).toString('base64url')}`;
    };
    const bad: Record<string, string> = {
      'another account in the claims': `${h}.${enc({ ...claims, sub: 'acc_someoneelse00' })}.${s}`,
      'alg none, no signature': `${enc({ alg: 'none', typ: 'JWT', kid: key.kid })}.${p}.`,
      'alg none, old signature': `${enc({ alg: 'none', typ: 'JWT', kid: key.kid })}.${p}.${s}`,
      'HS256 header': `${enc({ alg: 'HS256', typ: 'JWT', kid: key.kid })}.${p}.${s}`,
      'signed by a key edge does not hold': signSession(claims, other),
      'right kid, wrong key': forged({ alg: 'EdDSA', typ: 'JWT', kid: key.kid }, claims),
      'extra header field': forged({ alg: 'EdDSA', typ: 'JWT', kid: key.kid, jku: 'https://evil.test' }, claims, key),
      'extra claim': forged({ alg: 'EdDSA', typ: 'JWT', kid: key.kid }, { ...claims, admin: true }, key),
      'the fake format': `fake.${claims.sid}.${claims.sub}`,
      garbage: 'x.y.z',
      'too long': `${token}${'A'.repeat(3000)}`,
    };
    for (const [why, tok] of Object.entries(bad)) {
      b.cookie = `app_session=${tok}`;
      expect((await b.call('GET', '/api/me')).status, why).toBe(401);
    }
    b.cookie = `app_session=${token}`;
    expect((await b.call('GET', '/api/me')).status).toBe(200);
    t += 7 * 86400_000 + 1000;
    expect((await b.call('GET', '/api/me')).status, 'expired').toBe(401);
  });

  it('logout clears the cookie and the old token stops working at once, and on another edge within the cache time', async () => {
    const s = setup();
    const b = browser(s.app);
    await b.call('POST', '/api/signup', { email: 'lee@example.test', password: PW });
    const old = b.cookie!;
    // A second edge in front of the same accounts, which has the session cached as valid.
    const keys = sessionKeys(s.key.publicKey);
    let t = Date.now();
    const edge2 = createRealEdge({
      deps: { accounts: createClient({ baseUrl: 'http://accounts.internal', token: TEST_TOKENS.edge, fetch: (r) => s.accounts.app.fetch(r) }) },
      keys, origins: [ORIGIN], log: silent, clock: () => t, revalidateMs: 15_000,
    });
    const me2 = () => edge2.app.request('/api/me', { headers: { cookie: old } });
    expect((await me2()).status).not.toBe(401);
    const out = await b.call('POST', '/api/logout', {});
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/^app_session=; .*Max-Age=0/);
    b.cookie = old;
    expect((await b.call('GET', '/api/me')).status).toBe(401);
    t += 16_000;
    expect((await me2()).status).toBe(401);
  });

  it('logs in again after logout, with the email in any case', async () => {
    const { app } = setup();
    const b = browser(app);
    await b.call('POST', '/api/signup', { email: 'jo@example.test', password: PW });
    await b.call('POST', '/api/logout', {});
    expect((await b.call('POST', '/api/login', { email: 'JO@example.test', password: 'not the password' })).status).toBe(401);
    expect((await b.call('POST', '/api/login', { email: 'JO@example.test', password: PW })).status).toBe(201);
    expect((await b.call('GET', '/api/me')).status).toBe(200);
  });

  it('kid: edge derives the same key id accounts puts in the header', () => {
    const k = testKey();
    expect(kidOf(k.publicKey)).toBe(k.kid);
    expect(k.kid).toBe(createHash('sha256').update(Buffer.from(k.publicKey, 'base64url')).digest('base64url').slice(0, 16));
    const now = Math.floor(Date.now() / 1000);
    const tok = signSession({ sub: 'acc_abcdefgh', sid: 'ses_abcdefgh', plan: 'free', guest: false, iat: now, exp: now + 60 }, k);
    expect(verifySession(tok, sessionKeys(k.publicKey), now)?.sub).toBe('acc_abcdefgh');
    expect(verifySession(tok, sessionKeys(k.publicKey), now + 61)).toBeNull();
    expect(verifySession(tok, sessionKeys(testKey().publicKey), now)).toBeNull();
  });
});

describe('edge (real): Origin, rate limits, body cap', () => {
  it('refuses a state-changing call without our exact Origin (403), even with a valid cookie', async () => {
    const { app } = setup();
    const b = browser(app);
    await b.call('POST', '/api/signup', { email: 'ray@example.test', password: PW });
    const look = { theme: 'ice', mode: 'dark', hue: null };
    for (const origin of ['https://evil.test', 'https://vultrcontest.vaquerothe.dev.evil.test', 'http://vultrcontest.vaquerothe.dev', 'null'])
      expect((await b.call('PUT', '/api/look', look, { origin })).status, origin).toBe(403);
    const noOrigin = await app.request('/api/look', { method: 'PUT', headers: { cookie: b.cookie!, 'content-type': 'application/json' }, body: JSON.stringify(look) });
    expect(noOrigin.status).toBe(403);
    expect((await b.call('PUT', '/api/look', look, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await app.request('/api/me', { headers: { cookie: b.cookie! } })).status).toBe(200); // reads need no Origin
    expect((await b.call('PUT', '/api/look', look)).status).toBe(200);
  });

  it('limits sign-ups per address (429 with Retry-After); another address is not affected', async () => {
    const { app } = setup();
    const b = browser(app, '203.0.113.9');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await b.call('POST', '/api/signup', { email: `u${i}@example.test`, password: PW })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    const last = await b.call('POST', '/api/signup', { email: 'u9@example.test', password: PW });
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await browser(app, '203.0.113.10').call('POST', '/api/signup', { email: 'v@example.test', password: PW })).status).toBe(201);
  });

  it('limits chat per account, whatever address it comes from', async () => {
    const { app } = setup({ limits: { chat: { burst: 2, perSecond: 0.001 } } });
    const b = browser(app, '203.0.113.20');
    await b.call('POST', '/api/signup', { email: 'cat@example.test', password: PW });
    const msg = { conversation_id: null, widget_id: null, message: 'Chiefs tonight' };
    expect((await b.call('POST', '/api/chat', msg)).status).toBe(200);
    expect((await b.call('POST', '/api/chat', msg)).status).toBe(200);
    expect((await b.call('POST', '/api/chat', msg)).status).toBe(429);
    const moved = browser(app, '203.0.113.21');
    moved.cookie = b.cookie;
    expect((await moved.call('POST', '/api/chat', msg)).status).toBe(429);
  });

  it('limits every request per address', async () => {
    const { app } = setup({ limits: { address: { burst: 3, perSecond: 0.001 } } });
    const b = browser(app, '203.0.113.30');
    const s = [];
    for (let i = 0; i < 4; i++) s.push((await b.call('GET', '/api/audit/head')).status);
    expect(s).toEqual([200, 200, 200, 429]);
  });

  it('refuses a body over 64 KiB with 413 before reading it', async () => {
    const { app } = setup();
    const b = browser(app);
    await b.call('POST', '/api/signup', { email: 'big@example.test', password: PW });
    expect((await b.call('POST', '/api/chat', { conversation_id: null, widget_id: null, message: 'x'.repeat(70_000) })).status).toBe(413);
  });
});

describe('edge (real): the connect route is opaque', () => {
  it('passes the body on with only account_id set from the session, and never logs it', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'debug' }, { write: (s: string) => void lines.push(s) }) as unknown as Logger;
    const seen: unknown[] = [];
    const { app } = setup({
      log,
      connections: (c) => (async (e: Endpoint, input: never) => {
        if (e === CONNECTIONS.connect) seen.push((input as { body: unknown }).body);
        return c(e, input);
      }) as Call,
    });
    const b = browser(app);
    const me: any = await (await b.call('POST', '/api/signup', { email: 'vault@example.test', password: PW })).json();
    const wallet = '0x00000000000000000000000000000000c0ffee01';
    const res = await b.call('POST', '/api/connections', { exchange: 'polymarket', wallet, account_id: 'acc_someoneelse00' });
    expect(res.status).toBe(201);
    expect(seen).toEqual([{ exchange: 'polymarket', wallet, account_id: me.account.account_id }]);

    const sealed = 'SEALED-BOX-' + 'Q'.repeat(40);
    const bad = await b.call('POST', '/api/connections', { exchange: 'kalshi', key_id: 'k', key_type: 'rsa', sealed_key: sealed, env: 'prod' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(sealed);
    expect((await b.call('POST', '/api/connections', '["not", "an object"]')).status).toBe(400);
    const all = lines.join('\n');
    expect(all).toContain('"endpoint":"connect"');
    expect(all).not.toContain(sealed);
    expect(all).not.toContain(wallet);
  });
});

// ---------- /live over a real socket ----------

type Opened = { ws: WebSocket; frames: unknown[]; closed: Promise<{ code: number; reason: string }> };
function openLive(port: number, headers: Record<string, string>): Promise<Opened | { status: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers });
    const frames: unknown[] = [];
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, frames, closed }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.on('error', (e) => reject(e));
  });
}
const until = async (f: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('edge (real): /live', () => {
  const s = setup({ live: { maxPerAccount: 2 } });
  let server: ReturnType<typeof serve>;
  let port = 0;
  const a = browser(s.app);
  const b = browser(s.app);
  beforeAll(async () => {
    server = serve({ fetch: s.app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
    s.edge.attach(server as never);
    await a.call('POST', '/api/signup', { email: 'live-a@example.test', password: PW });
    await b.call('POST', '/api/signup', { email: 'live-b@example.test', password: PW });
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('refuses the handshake from another Origin or none (403), without a session (401), off the path (404)', async () => {
    expect(await openLive(port, { origin: 'https://evil.test', cookie: a.cookie! })).toEqual({ status: 403 });
    expect(await openLive(port, { origin: 'http://vultrcontest.vaquerothe.dev', cookie: a.cookie! })).toEqual({ status: 403 });
    expect(await openLive(port, { cookie: a.cookie! })).toEqual({ status: 403 });
    expect(await openLive(port, { origin: ORIGIN })).toEqual({ status: 401 });
    expect(await openLive(port, { origin: ORIGIN, cookie: 'app_session=x.y.z' })).toEqual({ status: 401 });
    const off = await new Promise<number>((r) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/me`, { headers: { origin: ORIGIN, cookie: a.cookie! } });
      ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0));
      ws.on('error', () => r(-1));
    });
    expect(off).toBe(404);
  });

  it("pushes an account's own events and nobody else's", async () => {
    const la = (await openLive(port, { origin: ORIGIN, cookie: a.cookie! })) as Opened;
    const lb = (await openLive(port, { origin: ORIGIN, cookie: b.cookie! })) as Opened;
    expect(la.ws.readyState).toBe(WebSocket.OPEN);
    expect((await a.call('PUT', '/api/look', { theme: 'aurora', mode: 'dark', hue: 280 })).status).toBe(200);
    await until(() => la.frames.length === 1);
    expect(la.frames[0]).toMatchObject({ event: 'look.changed', payload: { look: { theme: 'aurora', mode: 'dark', hue: 280 } } });
    await new Promise((r) => setTimeout(r, 50));
    expect(lb.frames).toEqual([]);
    la.ws.close();
    lb.ws.close();
  });

  it('caps sockets per account (429) and closes one that sends a big frame', async () => {
    const one = (await openLive(port, { origin: ORIGIN, cookie: a.cookie! })) as Opened;
    const two = (await openLive(port, { origin: ORIGIN, cookie: a.cookie! })) as Opened;
    await until(() => true);
    expect(await openLive(port, { origin: ORIGIN, cookie: a.cookie! })).toEqual({ status: 429 });
    one.ws.send('x'.repeat(2048));
    expect((await one.closed).code).toBe(1009);
    two.ws.close();
    await two.closed;
  });

  it('logout closes the session’s sockets (4001) and the old cookie cannot reopen one', async () => {
    const c = browser(s.app);
    await c.call('POST', '/api/signup', { email: 'live-c@example.test', password: PW });
    const old = c.cookie!;
    const lc = (await openLive(port, { origin: ORIGIN, cookie: old })) as Opened;
    await c.call('POST', '/api/logout', {});
    expect((await lc.closed).code).toBe(CLOSE.sessionEnded);
    expect(await openLive(port, { origin: ORIGIN, cookie: old })).toEqual({ status: 401 });
  });
});

describe('edge (real): config', () => {
  it('accepts only exact https origins (http for localhost)', async () => {
    const { checkOrigins } = await import('../src/real.ts');
    expect([...checkOrigins(['https://vultrcontest.vaquerothe.dev', 'http://localhost:5173'])]).toHaveLength(2);
    for (const bad of ['https://vultrcontest.vaquerothe.dev/', 'http://vultrcontest.vaquerothe.dev', '*', 'https://a.test/path'])
      expect(() => checkOrigins([bad]), bad).toThrow();
  });
  it('the connections fake still runs', () => {
    expect(fakeApp('connections', CONNECTIONS, connectionsFake())).toBeTruthy();
  });
});
