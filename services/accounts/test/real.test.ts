/**
 * The real accounts, in `make check`: the shared contract cases plus its own security checks, on the memory store.
 * The same handlers run on Postgres in pg.test.ts when ACCOUNTS_TEST_DATABASE_URL is set.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, SessionClaims, TRUST_ACTIONS } from '@app/contracts';
import { MemoryBus, createLogger } from '@app/service-kit';
import { outsider, runCase, TEST_TOKENS, type Ctx } from '@app/testkit';
import { hashPassword, verifyPassword, TEST_COST } from '../src/password.ts';
import { scheduleGuestSweep } from '../src/real.ts';
import { loadSigningKey } from '../src/session.ts';
import { memoryStore } from '../src/store.ts';
import { cases } from './cases.ts';
import { realAccounts } from './helpers.ts';

const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const asEdge = { authorization: `Bearer ${TEST_TOKENS.edge}`, 'content-type': 'application/json' };
const asBoard = { authorization: `Bearer ${TEST_TOKENS.board}` };
const post = (app: ReturnType<typeof realAccounts>['app'], path: string, body: unknown, headers: Record<string, string> = asEdge) =>
  app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

describe('accounts (real): the contract cases', () => {
  const { app } = realAccounts();
  const ctx: Ctx = {};
  for (const [i, c] of cases.entries())
    it(`${i + 1}. ${c.endpoint}${c.label ? ` (${c.label})` : ''}`, async () => {
      expect((await runCase(app, ACCOUNTS, c, ctx)).problems).toEqual([]);
    });

  it('refuses a caller the endpoint does not list (403) and a missing token (401)', async () => {
    for (const e of Object.values(ACCOUNTS)) {
      const path = e.path.replace(/:([a-z_]+)/g, 'x');
      const who = outsider(e)!;
      expect((await app.request(path, { method: e.method, headers: { authorization: `Bearer ${TEST_TOKENS[who]}` } })).status, `${e.name} as ${who}`).toBe(403);
      expect((await app.request(path, { method: e.method })).status, `${e.name} without a token`).toBe(401);
      expect((await app.request(path, { method: e.method, headers: { authorization: 'Bearer not-a-token' } })).status).toBe(401);
    }
  });
});

describe('accounts (real): passwords', () => {
  it('stores argon2id PHC strings that verify, and never the password', async () => {
    const h = await hashPassword('correct horse battery', TEST_COST);
    expect(h).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(h).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterY', h)).toBe(false);
    expect(await hashPassword('correct horse battery', TEST_COST)).not.toBe(h); // a new salt each time
  });

  it('refuses malformed or oversized stored hashes instead of running them', async () => {
    const h = await hashPassword('correct horse battery', TEST_COST);
    expect(await verifyPassword('correct horse battery', h.replace('m=1024', 'm=9999999'))).toBe(false);
    expect(await verifyPassword('correct horse battery', h.replace('$argon2id$', '$argon2i$'))).toBe(false);
    expect(await verifyPassword('correct horse battery', 'plain text')).toBe(false);
  });

  it('the default cost is OWASP argon2id (46 MiB, t=1, p=1)', async () => {
    expect(await hashPassword('correct horse battery')).toMatch(/^\$argon2id\$v=19\$m=47104,t=1,p=1\$/);
  });
});

describe('accounts (real): sign-up, login, sessions', () => {
  it('signs an Ed25519 JWT whose claims match SessionClaims, and never returns the hash', async () => {
    const { app, key } = realAccounts();
    const res = await post(app, '/accounts', { email: 'Ana@Example.test', password: 'correct horse battery' });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('argon2');
    const out = JSON.parse(text);
    expect(out.account.email).toBe('ana@example.test');
    const [h, p, s] = out.session.token.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: key.kid });
    const claims = SessionClaims.parse(JSON.parse(Buffer.from(p, 'base64url').toString()));
    expect(claims).toMatchObject({ sub: out.account.account_id, sid: out.session.session_id, plan: 'free', guest: false });
    expect(claims.exp - claims.iat).toBe(7 * 86400);
    expect(Buffer.from(s, 'base64url')).toHaveLength(64);
  });

  it('treats emails case-insensitively: a second sign-up is 409, login works in any case', async () => {
    const { app } = realAccounts();
    expect((await post(app, '/accounts', { email: 'kim@example.test', password: 'correct horse battery' })).status).toBe(201);
    expect((await post(app, '/accounts', { email: 'KIM@example.test', password: 'another password!' })).status).toBe(409);
    expect((await post(app, '/sessions', { email: 'Kim@Example.Test', password: 'correct horse battery' })).status).toBe(201);
  });

  it('answers the same 401 for an unknown email and a wrong password, and locks an email after 10 failures', async () => {
    const { app, bus } = realAccounts();
    await post(app, '/accounts', { email: 'lee@example.test', password: 'correct horse battery' });
    const unknown = await post(app, '/sessions', { email: 'nobody@example.test', password: 'correct horse battery' });
    const wrong = await post(app, '/sessions', { email: 'lee@example.test', password: 'wrong password!!' });
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(await unknown.json()).toEqual(await wrong.json());
    for (let i = 0; i < 9; i++) await post(app, '/sessions', { email: 'lee@example.test', password: 'wrong password!!' });
    expect((await post(app, '/sessions', { email: 'lee@example.test', password: 'correct horse battery' })).status).toBe(429);
    // The log holds a hash of the email, never the email or the password.
    const logged = JSON.stringify((bus as MemoryBus).entries);
    expect(logged).not.toContain('lee@example.test');
    expect(logged).not.toContain('wrong password');
    // Every refusal is a login.refused row for the trust page: 10 bad logins (account_id only for a known email), then the lock.
    const refused = (bus as MemoryBus).entries.filter((e) => e.action === TRUST_ACTIONS.loginRefused);
    expect(refused.map((e) => e.ids?.reason)).toEqual([...Array(11).fill('bad_login'), 'locked']);
    expect(refused[0]!.account_id).toBeNull();
    expect(refused[1]!.account_id).toBe(refused[2]!.account_id);
    expect(refused[1]!.account_id).toMatch(/./);
    expect(refused.every((e) => e.outcome === 'refused' && e.hashes?.email)).toBe(true);
    expect((bus as MemoryBus).entries.some((e) => e.action === 'login.failed')).toBe(false);
  });

  it('logout revokes the session: sessionValid turns false', async () => {
    const { app } = realAccounts();
    const out: any = await (await post(app, '/accounts', { email: 'jo@example.test', password: 'correct horse battery' })).json();
    const sid = out.session.session_id;
    const valid = async () => (await json(app.request(`/sessions/${sid}`, { headers: asEdge }))).valid;
    expect(await valid()).toBe(true);
    expect((await app.request(`/sessions/${sid}`, { method: 'DELETE', headers: asEdge })).status).toBe(200);
    expect(await valid()).toBe(false);
  });

  it('expired sessions are invalid', async () => {
    let t = Date.parse('2026-11-08T12:00:00Z');
    const { app } = realAccounts({ clock: () => t });
    const out: any = await (await post(app, '/guests', {})).json();
    expect(out.account.guest).toBe(true);
    expect(Date.parse(out.session.expires_at) - t).toBe(86400_000);
    t += 86400_000 + 1000;
    expect((await json(app.request(`/sessions/${out.session.session_id}`, { headers: asEdge }))).valid).toBe(false);
  });

  it('caps guests per hour (429)', async () => {
    const { app } = realAccounts({ guestsPerHour: 2 });
    expect([(await post(app, '/guests', {})).status, (await post(app, '/guests', {})).status, (await post(app, '/guests', {})).status]).toEqual([201, 201, 429]);
  });
});

describe('accounts (real): the look', () => {
  it('stores only a valid look and emits look.changed', async () => {
    const { app, bus } = realAccounts();
    const out: any = await (await post(app, '/accounts', { email: 'ray@example.test', password: 'correct horse battery' })).json();
    const put = (look: unknown) => app.request(`/accounts/${out.account.account_id}/look`, { method: 'PUT', headers: asEdge, body: JSON.stringify(look) });
    expect((await put({ theme: 'ice', mode: 'dark', hue: 200 })).status).toBe(200);
    for (const bad of [
      { theme: 'ice', mode: 'dark', hue: 361 },
      { theme: 'ice', mode: 'dark', hue: 20.5 },
      { theme: 'body{display:none}', mode: 'dark', hue: null },
      { theme: 'ice', mode: 'neon', hue: null },
      { theme: 'ice', mode: 'dark', hue: null, css: 'x' },
    ])
      expect((await put(bad)).status, JSON.stringify(bad)).toBe(400);
    const me: any = await (await app.request(`/accounts/${out.account.account_id}`, { headers: asEdge })).json();
    expect(me.look).toEqual({ theme: 'ice', mode: 'dark', hue: 200 });
    expect((bus as MemoryBus).events).toEqual([{ event: 'look.changed', payload: expect.objectContaining({ account_id: out.account.account_id }) }]);
  });

  it('a new account has the plan "free" (shown, not billed) and the default look', async () => {
    const { app } = realAccounts();
    const out: any = await (await post(app, '/accounts', { email: 'pat@example.test', password: 'correct horse battery' })).json();
    expect(out.account).toMatchObject({ plan: 'free', guest: false, look: { theme: 'agent-mail', mode: 'system', hue: null } });
  });
});

describe('accounts (real): the nightly guest sweep', () => {
  it('deletes guests made over an hour before 08:00 UTC, once a day, and their sessions stop being valid', async () => {
    let t = Date.parse('2026-11-08T06:30:00Z');
    const store = memoryStore();
    const { app } = realAccounts({ store, clock: () => t });
    const old: any = await (await post(app, '/guests', {})).json();
    const user: any = await (await post(app, '/accounts', { email: 'sue@example.test', password: 'correct horse battery' })).json();
    t = Date.parse('2026-11-08T07:30:00Z');
    const fresh: any = await (await post(app, '/guests', {})).json();
    const sweepBus = new MemoryBus();
    const sweep = scheduleGuestSweep(store, createLogger('accounts', 'silent'), sweepBus, 8, () => t);
    sweep.stop();
    expect(await sweep.tick()).toBeNull(); // not 08:00 yet
    t = Date.parse('2026-11-08T08:05:00Z');
    expect(await sweep.tick()).toBe(1);
    expect(await sweep.tick()).toBeNull(); // once a night
    const valid = async (sid: string) => (await json(app.request(`/sessions/${sid}`, { headers: asEdge }))).valid;
    expect(await valid(old.session.session_id)).toBe(false);
    expect(await valid(fresh.session.session_id)).toBe(true);
    expect(await valid(user.session.session_id)).toBe(true);
    expect((await app.request(`/accounts/${old.account.account_id}`, { headers: asEdge })).status).toBe(404);
    // One account.deleted row per swept guest, then the sweep's summary.
    expect(sweepBus.entries.map((e) => [e.action, e.account_id, e.sizes?.accounts])).toEqual([
      [TRUST_ACTIONS.accountDeleted, old.account.account_id, undefined],
      ['account.guests_swept', null, 1],
    ]);
    // account.deleted goes out on the bus too, so board, agent and connections delete the guest's rows.
    expect(sweepBus.events.filter((e) => e.event === 'account.deleted').map((e) => e.payload)).toEqual([
      { account_id: old.account.account_id, at: expect.any(String), reason: 'guest_sweep' },
    ]);
    // ACCOUNTS.missing (the orphan sweeps): the swept guest is missing, the user and the fresh guest are not.
    const ids = [old.account.account_id, user.account.account_id, fresh.account.account_id];
    const missing = await app.request('/accounts/missing', { method: 'POST', headers: { ...asBoard, 'content-type': 'application/json' }, body: JSON.stringify({ account_ids: ids }) });
    expect(await missing.json()).toEqual({ missing: [old.account.account_id] });
  });

  it('deleteGuests answers the deleted account ids', async () => {
    const store = memoryStore();
    const { app } = realAccounts({ store, clock: () => Date.parse('2026-11-08T06:00:00Z') });
    const a: any = await (await post(app, '/guests', {})).json();
    const b: any = await (await post(app, '/guests', {})).json();
    await post(app, '/accounts', { email: 'kim@example.test', password: 'correct horse battery' });
    const gone = await store.deleteGuests('2026-11-08T07:00:00Z');
    expect(gone.sort()).toEqual([a.account.account_id, b.account.account_id].sort());
    expect(await store.deleteGuests('2026-11-08T07:00:00Z')).toEqual([]);
  });
});

describe('accounts (real): the key file', () => {
  it('refuses a key file others can read, and anything but Ed25519', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vha-key-'));
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    writeFileSync(join(dir, 'open.pem'), pem, { mode: 0o644 });
    expect(() => loadSigningKey(join(dir, 'open.pem'))).toThrow(/readable by others/);
    writeFileSync(join(dir, 'ok.pem'), pem, { mode: 0o600 });
    expect(loadSigningKey(join(dir, 'ok.pem')).kid).toHaveLength(16);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    writeFileSync(join(dir, 'rsa.pem'), rsa, { mode: 0o600 });
    expect(() => loadSigningKey(join(dir, 'rsa.pem'))).toThrow(/Ed25519/);
  });
});
