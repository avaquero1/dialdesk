/**
 * The real accounts on Postgres: the migration, then the contract cases. Runs when ACCOUNTS_TEST_DATABASE_URL points
 * at a database whose role's search_path is the accounts schema (e.g. svc_accounts on a throwaway Compose Postgres);
 * skipped otherwise, so `make check` needs no database.
 */
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { ACCOUNTS } from '@app/contracts';
import { createLogger, migrate } from '@app/service-kit';
import { runCase, TEST_TOKENS, type Ctx } from '@app/testkit';
import { pgStore } from '../src/store.ts';
import { cases } from './cases.ts';
import { realAccounts } from './helpers.ts';

const url = process.env.ACCOUNTS_TEST_DATABASE_URL;

describe.skipIf(!url)('accounts (real, Postgres)', () => {
  const sql = postgres(url ?? 'postgres://unused', { max: 3, onnotice: () => {} });
  afterAll(() => sql.end());

  it('applies the migrations', async () => {
    await migrate({ databaseUrl: url!, schema: 'accounts', dir: fileURLToPath(new URL('../migrations', import.meta.url)), log: createLogger('accounts', 'silent') });
    await sql`truncate accounts cascade`;
    const cols = await sql`select column_name from information_schema.columns where table_schema = 'accounts' and table_name = 'accounts'`;
    expect(cols.map((c) => c.column_name).sort()).toEqual(['account_id', 'created_at', 'email', 'guest', 'look', 'password_hash', 'plan']);
  });

  const ctx: Ctx = {};
  let app: ReturnType<typeof realAccounts>['app'];
  it('runs the contract cases', async () => {
    app = realAccounts({ store: pgStore(sql) }).app;
    for (const c of cases) expect((await runCase(app, ACCOUNTS, c, ctx)).problems, c.endpoint).toEqual([]);
  });

  it('stores an argon2id hash, a lower-case email and a valid look; the database refuses a bad look or plain password', async () => {
    const [row] = await sql`select email, password_hash, look from accounts where email = 'sam@example.test'`;
    expect(row!.password_hash).toMatch(/^\$argon2id\$/);
    expect(row!.look).toEqual({ theme: 'deep-sea', mode: 'dark', hue: 32 });
    await expect(sql`update accounts set look = '{"css":"x"}'::jsonb where email = 'sam@example.test'`).rejects.toThrow(/check/);
    await expect(sql`update accounts set password_hash = 'hunter2' where email = 'sam@example.test'`).rejects.toThrow(/check/);
  });

  it('two sign-ups racing for one email: one wins, one gets 409', async () => {
    const body = JSON.stringify({ email: 'race@example.test', password: 'correct horse battery' });
    const req = () => app.request('/accounts', { method: 'POST', headers: { authorization: `Bearer ${TEST_TOKENS.edge}`, 'content-type': 'application/json' }, body });
    const statuses = (await Promise.all([req(), req(), req()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
  });

  it('deleting a guest deletes its sessions', async () => {
    const store = pgStore(sql);
    const g: any = await (await app.request('/guests', { method: 'POST', headers: { authorization: `Bearer ${TEST_TOKENS.edge}`, 'content-type': 'application/json' }, body: '{}' })).json();
    expect(await store.deleteGuests(new Date(Date.now() + 1000).toISOString())).toBeGreaterThanOrEqual(1);
    expect(await store.session(g.session.session_id)).toBeNull();
  });
});
