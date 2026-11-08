/**
 * The real runner worker on a real Valkey 8.1 (`make valkey-test`): the scheduler enqueues a widget run on BullMQ as
 * runner, `consumeWidgetRuns` (the worker real mode starts) picks it up and runs it on the fakes (board, markets, models,
 * connections, audit) and the real sandbox-manager binary on its stub backend. A research run on the poisoned page ends
 * `poisoned` on its first attempt; a poison job (a widget board doesn't have) fails at once with NoRetry, never retried.
 * Without VALKEY_TEST=1 (as in `make check`) the file is skipped.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD, CONNECTIONS, MARKETS, MODELS, QUEUES, newId, widgetRunJobId, type EventName, type Widget, type WidgetRunJob } from '@app/contracts';
import { ValkeyBus, createClient, createLogger, createQueue, hashToken, sandboxClient, type Bus } from '@app/service-kit';
import { fakeApp, fixtures, pageText, TEST_TOKENS } from '@app/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeAudit } from '../../audit/src/fake.ts';
import { fake as boardFake } from '../../board/src/fake.ts';
import { fake as connectionsFake } from '../../connections/src/fake.ts';
import { fake as marketsFake } from '../../markets/src/fake.ts';
import { fake as modelsFake } from '../../models/src/fake.ts';
import { consumeWidgetRuns } from '../src/real.ts';
import type { RunnerDeps } from '../src/run.ts';
import { Scheduler } from '../src/scheduler.ts';
import { MemoryStore } from '../src/store.ts';

const on = process.env.VALKEY_TEST === '1';
const port = process.env.VALKEY_TEST_PORT ?? '56379';
const MANAGER = join(import.meta.dirname, '../../../target/debug/sandbox-manager');
const SM_PORT = 19700 + (process.pid % 200);

/** runner's own Valkey user from `.env`, moved to the test project's port. */
function runnerUrl(): string {
  const line = readFileSync(join(import.meta.dirname, '../../../.env'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('RUNNER_VALKEY_URL='));
  if (!line) throw new Error('no RUNNER_VALKEY_URL in .env: run make dev-secrets');
  return line.slice('RUNNER_VALKEY_URL='.length).replace(/:56379$/, `:${port}`);
}

const fast = { backoff: { type: 'fixed' as const, delay: 200 } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(50);
  }
}

describe.skipIf(!on)('runner worker on Valkey', () => {
  let manager: ChildProcess | undefined;
  const closers: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const c of closers.reverse()) await c().catch(() => {});
    manager?.kill('SIGTERM');
  });

  const marketsApp = fakeApp('markets', MARKETS, marketsFake());
  const via = (caller: keyof typeof TEST_TOKENS, app: { fetch: (r: Request) => Response | Promise<Response> }) =>
    createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });
  const boardApp = fakeApp('board', BOARD, boardFake({ markets: via('board', marketsApp), enqueue: () => undefined }));
  const audit = createFakeAudit();
  const store = new MemoryStore();
  const events: { event: EventName; run_id?: string }[] = [];
  let clock = Date.now();
  let scheduler: Scheduler;
  const failed: Record<string, { message: string; attempts: number }> = {};
  const completed: Record<string, number> = {};
  const errors: string[] = [];

  beforeAll(async () => {
    if (!existsSync(MANAGER)) throw new Error(`build ${MANAGER} first (make rust)`);
    manager = spawn(MANAGER, ['serve'], {
      env: { ...process.env, SANDBOX_MANAGER_ADDR: `127.0.0.1:${SM_PORT}`, SANDBOX_MANAGER_CALLERS: `runner:${hashToken(TEST_TOKENS.runner)}`, SANDBOX_MANAGER_DEV: '1' },
      stdio: 'ignore',
    });
    for (let i = 0; (await fetch(`http://127.0.0.1:${SM_PORT}/health`).then((r) => r.ok).catch(() => false)) === false; i++) {
      if (i > 100) throw new Error('sandbox-manager did not start');
      await wait(100);
    }
    const url = runnerUrl();
    // runner's real bus, as runner's ACL user; the test keeps a copy of what it emits.
    const valkey = new ValkeyBus(url, 'runner');
    closers.push(() => valkey.close());
    const bus: Bus = {
      emit: async (event, payload) => {
        events.push({ event, run_id: (payload as { run_id?: string }).run_id });
        await valkey.emit(event, payload);
      },
      log: (e) => valkey.log(e),
    };
    const queue = createQueue(QUEUES.widgetRuns, url, 'runner', fast);
    closers.push(() => queue.close());
    scheduler = new Scheduler(store, (j) => queue.enqueue(j), () => clock);
    const deps: RunnerDeps = {
      board: via('runner', boardApp),
      markets: via('runner', marketsApp),
      models: via('runner', fakeApp('models', MODELS, modelsFake())),
      connections: via('runner', fakeApp('connections', CONNECTIONS, connectionsFake())),
      sandbox: sandboxClient({ baseUrl: `http://127.0.0.1:${SM_PORT}`, token: TEST_TOKENS.runner }),
      bus,
      audit: async (e) => {
        await bus.log(e);
        return audit.append(e).row_id;
      },
      store,
      sourceEnv: 'fixture',
      pageText: (u) => {
        const p = fixtures.manifest().find((x) => x.url === u);
        return p ? pageText(fixtures.page(p.file)) : null;
      },
      pollMs: 10,
      onRunEnd: (w, job) => scheduler.noteRun(w, job),
      onWidgetGone: (id) => scheduler.forget(id),
    };
    const w = consumeWidgetRuns(deps, url, createLogger('runner', 'silent'));
    closers.push(() => w.close());
    w.worker.on('failed', (job, err) => (failed[job!.data.widget_id] = { message: err.message, attempts: job!.attemptsMade }));
    w.worker.on('completed', (job) => (completed[job.data.widget_id] = job.attemptsMade));
    w.worker.on('error', (e) => errors.push(e.message));
  }, 30_000);

  const edgeBoard = via('edge', boardApp);
  async function freshBoard() {
    const account_id = `acc_valkeyrun${Math.floor(Math.random() * 1e9)}`;
    const b = await edgeBoard(BOARD.createDefaults, { params: { account_id }, body: { category: 'sports' } });
    return (t: string) => b.widgets.find((x) => x.spec.title === t)!;
  }
  const current = (w: Widget) => via('runner', boardApp)(BOARD.getWidget, { params: { widget_id: w.spec.widget_id }, query: { account_id: w.spec.account_id } });

  it("the scheduler enqueues a due numbers run on BullMQ; runner's worker runs it to done on the first attempt", async () => {
    const w = (await freshBoard())('Chiefs beat the Bills');
    const every = w.profile!.cadence.numbers_every_s ?? 0;
    expect(every).toBeGreaterThan(0);
    await scheduler.noteRun(w, { kind: 'numbers', reason: 'accept' });
    await store.schedule.remove(w.spec.widget_id, 'research'); // this test is about one run
    expect(await scheduler.tick()).toEqual([]); // not due yet
    clock += every * 1000;
    const jobs = await scheduler.tick();
    expect(jobs.map((j) => [j.widget_id, j.kind, j.reason])).toEqual([[w.spec.widget_id, 'numbers', 'schedule']]);

    await until(() => w.spec.widget_id in completed || w.spec.widget_id in failed);
    expect(failed[w.spec.widget_id]).toBeUndefined();
    expect(completed[w.spec.widget_id]).toBe(1);
    const rec = await store.get(store.byJob.get(jobs[0]!.job_id)!);
    expect(rec).toMatchObject({ status: 'done', attempt: 1 });
    const r = (await current(w)).result!;
    expect(r.numbers.map((n) => n.op)).toContain('implied_probability');
    // after the run, runner booked the next window
    expect((await store.schedule.get(w.spec.widget_id, 'numbers'))!.next_at).toBeGreaterThan(clock);
  }, 40_000);

  it("a board's due numbers widgets go on BullMQ as one job, and each widget gets its own result (A1.4.1)", async () => {
    const byTitle = await freshBoard();
    const ws = ['Chiefs beat the Bills', 'Positions', 'Tonight'].map(byTitle).filter((w) => w && w.spec.kind === 'display');
    const numbers = ws.filter((w) => w.profile!.cadence.numbers_every_s);
    expect(numbers.length).toBeGreaterThan(1);
    for (const w of numbers) {
      await scheduler.noteRun(w, { kind: 'numbers', reason: 'accept' });
      await store.schedule.remove(w.spec.widget_id, 'research');
    }
    clock += 3600_000;
    const jobs = (await scheduler.tick()).filter((j) => j.account_id === numbers[0]!.spec.account_id);
    expect(jobs).toHaveLength(1);
    const lead = jobs[0]!;
    expect((await store.batches.get(lead.job_id))!.widget_ids.sort()).toEqual(numbers.map((w) => w.spec.widget_id).sort());
    await until(() => lead.widget_id in completed || lead.widget_id in failed);
    expect(failed[lead.widget_id]).toBeUndefined();
    for (const w of numbers) {
      const rec = await store.get(store.byJob.get(widgetRunJobId(w.spec.widget_id, 'numbers', lead.window_start))!);
      expect(rec?.status).toBe('done');
    }
  }, 40_000);

  it('a research run that meets the poisoned page ends poisoned on its first attempt, with no retry', async () => {
    const w = (await freshBoard())('Bills news');
    const window_start = Math.floor(clock / 1000);
    await createQueueAsRunner().enqueue({ job_id: widgetRunJobId(w.spec.widget_id, 'research', window_start), widget_id: w.spec.widget_id, account_id: w.spec.account_id, kind: 'research', window_start, reason: 'accept' });
    await until(() => w.spec.widget_id in completed || w.spec.widget_id in failed);
    expect(failed[w.spec.widget_id]).toBeUndefined();
    expect(completed[w.spec.widget_id]).toBe(1);
    expect(events.filter((e) => e.event === 'run.poisoned')).toHaveLength(1);
  }, 40_000);

  it('a poison job (a widget board does not have) fails at once with NoRetry: one attempt, run.failed, schedule dropped', async () => {
    const widget_id = newId('wid');
    const job: WidgetRunJob = { job_id: widgetRunJobId(widget_id, 'numbers', 1), widget_id, account_id: newId('acc'), kind: 'numbers', window_start: 1, reason: 'schedule' };
    await createQueueAsRunner().enqueue(job);
    await until(() => widget_id in failed);
    await wait(600); // longer than the backoff: a retry would show here
    expect(failed[widget_id]).toEqual({ message: 'widget gone', attempts: 1 });
    expect(completed[widget_id]).toBeUndefined();
    expect(events.filter((e) => e.event === 'run.failed')).toHaveLength(1);
    expect(errors).toEqual([]); // no NOPERM in BullMQ's scripts as runner
  }, 40_000);

  function createQueueAsRunner() {
    const q = createQueue(QUEUES.widgetRuns, runnerUrl(), 'runner', fast);
    closers.push(() => q.close());
    return q;
  }
});
