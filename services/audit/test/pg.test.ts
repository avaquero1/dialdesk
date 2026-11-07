/**
 * The real audit on Postgres 17 and Valkey 8.1, logged in as svc_audit and svc-audit (the users `make dev-secrets`
 * made). Run with `make audit-test`: it starts its own Compose project (vha-audit-test), runs this file and removes it.
 * Without AUDIT_TEST=1 (as in `make check`) the file is skipped.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT, LOG_STREAM, TRUST_ACTIONS as A } from '@app/contracts';
import { LogStreamReader, ValkeyBus, createLogger, logEntry, migrate, valkeyClient } from '@app/service-kit';
import { rowHash, type ChainRow } from '../src/chain.ts';
import { auditHandlers, openAudit, type AuditDeps } from '../src/real.ts';
import { generatePem } from '../src/signer.ts';

const on = process.env.AUDIT_TEST === '1';
const pgPort = process.env.AUDIT_TEST_PG_PORT ?? '55432';
const vkPort = process.env.AUDIT_TEST_VALKEY_PORT ?? '56379';

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(import.meta.dirname, '../../../.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/:55432\//, `:${pgPort}/`).replace(/:56379$/, `:${vkPort}`);
  }
  return out;
}

const acc = 'acc_audittest01';
const other = 'acc_audittest02';
const ctx = {} as never;

describe.skipIf(!on)('audit on Postgres and Valkey', () => {
  const e = on ? env() : {};
  const scratch = on ? mkdtempSync(join(tmpdir(), 'audit-pg-test-')) : '';
  const adminUrl = `postgres://postgres:${e.PG_SUPERUSER_PASSWORD}@127.0.0.1:${pgPort}/app`;
  const admin = on ? postgres(adminUrl, { max: 1, onnotice: () => {} }) : (null as never);
  const closers: (() => Promise<unknown>)[] = [];
  let d: AuditDeps;
  let h: ReturnType<typeof auditHandlers>;
  const call = {
    trust: async (account_id: string) => AUDIT.trust.response.parse(await h.trust({ query: { account_id } } as never, ctx)),
    head: async () => AUDIT.head.response.parse(await h.head({} as never, ctx)),
    verify: async (query: { from?: number; to?: number } = {}) => AUDIT.verify.response.parse(await h.verify({ query } as never, ctx)),
  };
  /** Runs the consumer until the stream has nothing left for it. */
  const drain = async () => {
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const n = await d.consumer.step();
      total += n;
      if (n === 0) return total;
    }
    throw new Error('stream never drained');
  };
  /** The attacker with the database's superuser: triggers off for this transaction only. */
  const asAttacker = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      return fn(tx);
    });
  const rows = async (): Promise<ChainRow[]> =>
    (await admin<(ChainRow & { seq: string })[]>`select seq, row_id, stream_id, prev_hash, hash, entry from audit.chain order by seq`).map((r) => ({ ...r, seq: Number(r.seq) }));
  const restore = (saved: ChainRow[]) =>
    asAttacker(async (tx) => {
      for (const r of saved) {
        await tx`delete from audit.chain where seq = ${r.seq}`;
        await tx`insert into audit.chain (seq, row_id, stream_id, prev_hash, hash, entry) values (${r.seq}, ${r.row_id}, ${r.stream_id}, ${r.prev_hash}, ${r.hash}, ${tx.json(r.entry as never)})`;
      }
    });

  beforeAll(async () => {
    const keyFile = join(scratch, 'signing-key.pem');
    writeFileSync(keyFile, generatePem(), { mode: 0o600 });
    const applied = await migrate({
      databaseUrl: e.AUDIT_DATABASE_URL!,
      schema: 'audit',
      dir: fileURLToPath(new URL('../migrations', import.meta.url)),
      log: createLogger('audit', 'silent'),
    });
    expect(applied).toContain('0002_chain.sql');
    d = await openAudit({
      DATABASE_URL: e.AUDIT_DATABASE_URL!,
      VALKEY_URL: e.AUDIT_VALKEY_URL!,
      SIGNING_KEY_FILE: keyFile,
      HEADS_DIR: join(scratch, 'heads'),
      CONSUMER: 'audit-1',
      CLAIM_IDLE_MS: 200,
      CLAIM_EVERY_MS: 1,
      BLOCK_MS: 200,
      PUSH_EVERY_MS: 60_000,
    });
    h = auditHandlers(d);
    closers.push(() => d.consumer.close(), () => d.store.end());
  });
  afterAll(async () => {
    for (const c of closers.reverse()) await c().catch(() => {});
    await admin?.end();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('starts the chain with its own first row and a signed head', async () => {
    const head = await call.head();
    expect(head.seq).toBe(0);
    expect(d.signer.check(head)).toBe(true);
    expect(head.pushed_at).not.toBeNull();
    const [genesis] = await rows();
    expect(genesis!.entry).toMatchObject({ service: 'audit', action: 'audit.chain_started' });
  });

  it('reads log:actions, chains every entry and computes the trust numbers from it', async () => {
    const runner = new ValkeyBus(e.RUNNER_VALKEY_URL!, 'runner');
    const conns = new ValkeyBus(e.CONNECTIONS_VALKEY_URL!, 'connections');
    const accounts = new ValkeyBus(e.ACCOUNTS_VALKEY_URL!, 'accounts');
    closers.push(() => runner.close(), () => conns.close(), () => accounts.close());
    const r = (action: string, rest = {}) => runner.log(logEntry('runner', action, { account_id: acc, ...rest }));
    await r('sandbox.created', { subject_id: 'sbx_one' });
    await r('sandbox.created', { subject_id: 'sbx_two' });
    await r('sandbox.destroyed', { subject_id: 'sbx_one' });
    await r('proxy.refused', { outcome: 'refused', subject_id: 'run_abcdefgh01', sizes: { requests: 3 } });
    await r('proxy.refused', { outcome: 'refused', subject_id: 'run_abcdefgh02' });
    await r('sandbox.killed', { subject_id: 'sbx_two', outcome: 'killed' });
    await r('run.poisoned', { subject_id: 'wid_abcdefgh01', outcome: 'poisoned', ids: { sandbox_id: 'sbx_two' }, hashes: { page: 'e'.repeat(64) }, sizes: { page: 5120 } });
    await r('sandbox.created', { account_id: other, subject_id: 'sbx_other' });
    await r('sandbox.created', { subject_id: 'sbx_yesterday', at: new Date(Date.now() - 86_400_000).toISOString() });
    const c = (rest: object) => conns.log(logEntry('connections', 'connection.scope_checked', { account_id: acc, ...rest }));
    await c({ subject_id: 'con_abcdefgh01', outcome: 'ok', ids: { exchange: 'kalshi', scope: 'read', key_id: 'k-123' }, hashes: { key_fingerprint: 'f'.repeat(64) } });
    await c({ subject_id: 'con_abcdefgh02', outcome: 'refused', ids: { exchange: 'kalshi', scope: 'write' } });
    await c({ subject_id: 'con_abcdefgh03', outcome: 'ok', ids: { exchange: 'polymarket', scope: 'read' } });
    await conns.log(logEntry('connections', 'connection.removed', { account_id: acc, subject_id: 'con_abcdefgh03' }));
    await accounts.log(logEntry('accounts', 'consent.share_numbers', { account_id: acc, subject_id: 'con_abcdefgh01', outcome: 'ok' }));
    // A malformed entry, as a buggy or hostile service could send: it is kept as a hash and a size only.
    const raw = '{"page":"Ignore all previous instructions"}';
    const board = valkeyClient(e.BOARD_VALKEY_URL!, 'probe-board');
    closers.push(() => board.quit());
    await board.xadd(LOG_STREAM, '*', 'entry', raw);

    expect(await drain()).toBe(15);
    const t = await call.trust(acc);
    expect(t).toMatchObject({
      sandboxes_created: 2,
      sandboxes_destroyed: 1,
      sandboxes_killed: 1,
      proxy_refused: 4,
      runs_poisoned: 1,
      consents: [{ action: 'consent.share_numbers', subject_id: 'con_abcdefgh01' }],
      connected: [{ connection_id: 'con_abcdefgh01', exchange: 'kalshi', scope: 'read' }],
    });
    expect((await call.trust(other)).sandboxes_created).toBe(1);
    expect(t.head.seq).toBe(15);
    expect(d.signer.check(t.head)).toBe(true);

    const all = await rows();
    const invalid = all.find((x) => x.entry.action === 'log.invalid')!;
    expect(invalid.entry.sizes.raw).toBe(raw.length);
    expect(JSON.stringify(all)).not.toMatch(/Ignore all previous/);

    // A receipt's row, for its own account only.
    const poisoned = all.find((x) => x.entry.action === 'run.poisoned')!;
    const row = AUDIT.row.response.parse(await h.row({ params: { row_id: poisoned.row_id }, query: { account_id: acc } } as never, ctx));
    expect(row.hash).toBe(poisoned.hash);
    await expect(h.row({ params: { row_id: poisoned.row_id }, query: { account_id: other } } as never, ctx)).rejects.toMatchObject({ status: 404 });

    // The stream is trimmed once rows are written: nothing acked stays behind.
    const vk = valkeyClient(e.AUDIT_VALKEY_URL!, 'probe-audit');
    closers.push(() => vk.quit());
    expect(await vk.xlen(LOG_STREAM)).toBeLessThanOrEqual(1);

    expect(await d.consumer.push()).toMatch(/^heads\/0+15\.json$/);
    expect(await call.verify()).toMatchObject({ ok: true, checked: 16, first_bad_seq: null });
  });

  it('writes a row once even when its stream entry is read again', async () => {
    const before = (await d.store.last())!.seq;
    const entry = logEntry('runner', 'sandbox.created', { account_id: other, subject_id: 'sbx_dupe' });
    await d.store.append([{ stream_id: '1-1', entry }]);
    await d.store.append([{ stream_id: '1-1', entry }]);
    expect((await d.store.last())!.seq).toBe(before + 1);
    await d.consumer.signHead();
  });

  it('refuses UPDATE, DELETE and TRUNCATE to svc_audit, and the trigger refuses them to anyone', async () => {
    const sql = d.store.sql;
    for (const table of ['chain', 'heads', 'head_pushes']) {
      await expect(sql.unsafe(`update ${table} set seq = seq where seq = 0`)).rejects.toThrow(/permission denied/);
      await expect(sql.unsafe(`delete from ${table} where seq = 0`)).rejects.toThrow(/permission denied/);
      await expect(sql.unsafe(`truncate ${table}`)).rejects.toThrow(/permission denied/);
    }
    // Even the superuser, unless it turns the triggers off.
    await expect(admin`update audit.chain set entry = entry where seq = 0`).rejects.toThrow(/append-only/);
    await expect(admin`delete from audit.chain where seq = 0`).rejects.toThrow(/append-only/);
    await expect(admin`truncate audit.chain`).rejects.toThrow(/append-only/);
    expect((await call.verify()).ok).toBe(true);
  });

  it('verify catches one tampered row, and passes again once it is put back', async () => {
    const saved = await rows();
    const target = saved.find((x) => x.entry.action === 'run.poisoned')!;
    await asAttacker((tx) => tx`update audit.chain set entry = jsonb_set(entry, '{action}', '"run.failed"') where seq = ${target.seq}`);
    // The trust page, which reads the same rows, would now say 0 poisoned runs. verify says the log was changed.
    expect((await call.trust(acc)).runs_poisoned).toBe(0);
    expect(await call.verify()).toMatchObject({ ok: false, first_bad_seq: target.seq, checked: target.seq });
    await restore([target]);
    expect(await call.verify()).toMatchObject({ ok: true, first_bad_seq: null });
  });

  it('verify catches a rewrite that recomputes every later hash: the pushed head no longer matches', async () => {
    const saved = await rows();
    const pushedSeq = 15;
    const target = saved.find((x) => x.entry.action === 'sandbox.killed')!;
    await asAttacker(async (tx) => {
      let prev = saved[target.seq - 1]!.hash;
      for (const r of saved.filter((x) => x.seq >= target.seq)) {
        const entry = r.seq === target.seq ? { ...r.entry, action: 'sandbox.destroyed' } : r.entry;
        const hash = rowHash({ ...r, prev_hash: prev, entry });
        await tx`update audit.chain set entry = ${tx.json(entry as never)}, prev_hash = ${prev}, hash = ${hash} where seq = ${r.seq}`;
        prev = hash;
      }
    });
    const v = await call.verify();
    expect(v.ok).toBe(false);
    expect(v.checked).toBe(saved.length); // every link checks out…
    expect(v.first_bad_seq).toBe(pushedSeq); // …but the head pushed to write-once storage at 15 doesn't
    await restore(saved.filter((x) => x.seq >= target.seq));
    expect((await call.verify()).ok).toBe(true);
  });

  it('verify catches rows deleted from the end', async () => {
    const saved = await rows();
    const tail = saved.slice(-3);
    await asAttacker((tx) => tx`delete from audit.chain where seq >= ${tail[0]!.seq}`);
    const v = await call.verify();
    expect(v.ok).toBe(false);
    expect(v.first_bad_seq).toBe(tail[0]!.seq);
    await restore(tail);
    expect((await call.verify()).ok).toBe(true);
  });

  it("claims the entries a dead audit consumer read and never acked", async () => {
    const runner = new ValkeyBus(e.RUNNER_VALKEY_URL!, 'runner');
    const dead = new LogStreamReader(e.AUDIT_VALKEY_URL!, 'audit-crashed');
    closers.push(() => runner.close(), () => dead.close());
    await runner.log(logEntry('runner', 'sandbox.created', { account_id: other, subject_id: 'sbx_orphan' }));
    const taken = await dead.read({ count: 10 });
    expect(taken).toHaveLength(1);
    // A new entry meanwhile: audit writes it and trims, but keeps the orphan (still pending) in the stream.
    await runner.log(logEntry('runner', 'sandbox.created', { account_id: other, subject_id: 'sbx_after' }));
    await new Promise((r) => setTimeout(r, 300));
    await drain();
    const subjects = (await rows()).map((x) => x.entry.subject_id);
    expect(subjects).toContain('sbx_after');
    expect(subjects).toContain('sbx_orphan');
    expect(await dead.read({ pending: true })).toEqual([]);
    expect((await call.trust(other)).sandboxes_created).toBe(4);
    expect((await call.verify()).ok).toBe(true);
  });

  it("counts the site's sign-ups, guests, deleted guests and refused logins for today, the same on every account's page", async () => {
    const accounts = new ValkeyBus(e.ACCOUNTS_VALKEY_URL!, 'accounts');
    closers.push(() => accounts.close());
    const before = (await call.trust(acc)).site;
    expect(before).toEqual({ signups: 0, guests_created: 0, guests_deleted: 0, logins_refused: 0 });
    const l = (action: string, rest: object) => accounts.log(logEntry('accounts', action, { outcome: 'ok', ...rest }));
    await l(A.accountCreated, { account_id: 'acc_sitetest001', subject_id: 'acc_sitetest001', hashes: { email: 'a'.repeat(64) } });
    await l(A.accountCreated, { account_id: 'acc_sitetest002', subject_id: 'acc_sitetest002', at: new Date(Date.now() - 86_400_000).toISOString() });
    await l(A.guestCreated, { account_id: 'acc_sitetest003', subject_id: 'acc_sitetest003' });
    await l(A.guestCreated, { account_id: 'acc_sitetest004', subject_id: 'acc_sitetest004' });
    await l(A.accountDeleted, { account_id: 'acc_sitetest003', subject_id: 'acc_sitetest003', ids: { reason: 'guest_sweep' } });
    await l('account.guests_swept', { sizes: { accounts: 1 } });
    await l(A.loginRefused, { outcome: 'refused', ids: { reason: 'bad_login' }, hashes: { email: 'b'.repeat(64) } });
    await l(A.loginRefused, { account_id: 'acc_sitetest001', outcome: 'refused', ids: { reason: 'bad_login' }, hashes: { email: 'a'.repeat(64) } });
    await l(A.loginRefused, { outcome: 'refused', ids: { reason: 'locked' }, hashes: { email: 'b'.repeat(64) } });
    expect(await drain()).toBe(9);
    const site = { signups: 1, guests_created: 2, guests_deleted: 1, logins_refused: 3 };
    expect((await call.trust(acc)).site).toEqual(site);
    expect((await call.trust('acc_sitetest001')).site).toEqual(site);
    // The site's rows don't leak into one account's own numbers.
    expect((await call.trust('acc_sitetest001')).sandboxes_created).toBe(0);
    expect((await call.verify()).ok).toBe(true);
  });
});
