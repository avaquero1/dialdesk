/**
 * PgStore against Postgres: run_state resume by job id, saves, and the schedule. Needs a database: the URL comes from
 * RUNNER_TEST_DATABASE_URL. Without a reachable one the suite is skipped and says so. Each run uses a fresh schema.
 */
import { join } from 'node:path';
import { newId, widgetRunJobId, type WidgetRunJob } from '@app/contracts';
import { createLogger, migrate } from '@app/service-kit';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/store.ts';

const url = process.env.RUNNER_TEST_DATABASE_URL;
const schema = `runner_test_${process.pid}`;

async function reachable(u: string | undefined): Promise<boolean> {
  if (!u) return false;
  const probe = postgres(u, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const ok = await reachable(url);
if (!ok) console.warn('runner PgStore tests skipped: set RUNNER_TEST_DATABASE_URL to a reachable Postgres');

describe.skipIf(!ok)('PgStore', async () => {
  const admin = ok ? postgres(url!, { max: 1, onnotice: () => {} }) : null!;
  if (ok) {
    await admin`create schema if not exists ${admin(schema)}`;
    await migrate({ databaseUrl: url!, schema, dir: join(import.meta.dirname, '../migrations'), log: createLogger('runner', 'silent') });
  }
  const sql = ok ? postgres(url!, { max: 2, onnotice: () => {}, connection: { search_path: schema } }) : null!;
  const store = new PgStore(sql);
  afterAll(async () => {
    await sql.end({ timeout: 1 });
    await admin`drop schema if exists ${admin(schema)} cascade`;
    await admin.end({ timeout: 1 });
  });

  const widget_id = newId('wid');
  const job: WidgetRunJob = { job_id: widgetRunJobId(widget_id, 'research', 1794096000), widget_id, account_id: newId('acc'), kind: 'research', window_start: 1794096000, reason: 'accept' };

  it('begin returns the same run for the same job id, and save keeps steps and outputs', async () => {
    const a = await store.begin(job, newId('run'), new Date().toISOString());
    expect(a).toMatchObject({ status: 'running', steps: [], outputs: {}, attempt: 1, finished_at: null });
    a.last_step = 'plan';
    a.outputs = { plan: { candidate_ids: ['cnd_aaaaaaaaaaaa'] } };
    a.attempt = 2;
    await store.save(a);
    const b = await store.begin(job, newId('run'), new Date().toISOString());
    expect(b.run_id).toBe(a.run_id);
    expect(b).toMatchObject({ last_step: 'plan', attempt: 2, outputs: { plan: { candidate_ids: ['cnd_aaaaaaaaaaaa'] } } });
    b.status = 'done';
    b.finished_at = new Date().toISOString();
    await store.save(b);
    expect((await store.get(a.run_id))!.status).toBe('done');
    expect(await store.get('run_missing00000001')).toBeNull();
  });

  it('the schedule: put, due in order, remove', async () => {
    const base = { account_id: job.account_id, every_s: 120, active_at: Date.now() };
    await store.schedule.put({ ...base, widget_id, kind: 'numbers', next_at: 2000 });
    await store.schedule.put({ ...base, widget_id, kind: 'research', every_s: 3600, next_at: 1000 });
    expect((await store.schedule.due(1500, 10)).map((r) => r.kind)).toEqual(['research']);
    expect((await store.schedule.due(5000, 10)).map((r) => r.kind)).toEqual(['research', 'numbers']);
    await store.schedule.put({ ...base, widget_id, kind: 'numbers', next_at: 9000 });
    expect((await store.schedule.get(widget_id, 'numbers'))!.next_at).toBe(9000);
    await store.schedule.remove(widget_id, 'research');
    expect(await store.schedule.get(widget_id, 'research')).toBeNull();
    await store.schedule.remove(widget_id);
    expect(await store.schedule.due(1e13, 10)).toEqual([]);
  });
});
