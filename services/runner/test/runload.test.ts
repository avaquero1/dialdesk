/**
 * Runs fit the machine (A1.4.1): the scheduler runs only boards opened recently, folder cards at the slow speed, and
 * one compute box per board per tick for numbers (batch.ts). Unit tests for the schedule and the batching, an
 * integration run of one board's batch on the fakes and the real sandbox-manager (stub backend), and a load test:
 * twenty users' boards ticked together, counting compute boxes per board per tick.
 * The integration and load tests need target/debug/sandbox-manager (make check builds it first).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD, CONNECTIONS, MARKETS, MODELS, TRUST_ACTIONS, type EngineInput, type EngineResult, type SbxJobStatus, type Widget, type WidgetRunJob } from '@app/contracts';
import { MemoryBus, RUN_RULES, SandboxBusy, createClient, hashToken, sandboxClient, type CallError, type SandboxClient } from '@app/service-kit';
import { fakeApp, TEST_TOKENS } from '@app/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeAudit } from '../../audit/src/fake.ts';
import { fake as boardFake } from '../../board/src/fake.ts';
import { fake as connectionsFake } from '../../connections/src/fake.ts';
import { fake as marketsFake } from '../../markets/src/fake.ts';
import { fake as modelsFake } from '../../models/src/fake.ts';
import { AccountBatches, ComputeBatch, merge, slice } from '../src/batch.ts';
import { openedFrom, runJob } from '../src/real.ts';
import { handleRun, type ComputeRunner, type RunnerDeps } from '../src/run.ts';
import { Scheduler, everyS, nextWindow } from '../src/scheduler.ts';
import { MemoryStore, type RunRecord } from '../src/store.ts';

const MANAGER = join(import.meta.dirname, '../../../target/debug/sandbox-manager');
const PORT = 19700 + (process.pid % 200);
const have = existsSync(MANAGER);

const marketsApp = fakeApp('markets', MARKETS, marketsFake());
const via = (caller: keyof typeof TEST_TOKENS, app: { fetch: (r: Request) => Response | Promise<Response> }) =>
  createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });
const boardApp = fakeApp('board', BOARD, boardFake({ markets: via('board', marketsApp), enqueue: () => undefined }));
const edgeBoard = via('edge', boardApp);
const runnerBoard = via('runner', boardApp);
const audit = createFakeAudit();
const ctx = (attempt = 1) => ({ jobId: 'j', attempt, signal: new AbortController().signal });

let seq = 0;
async function freshBoard(open = true) {
  const account_id = `acc_runload${String(++seq).padStart(4, '0')}${Math.floor(Math.random() * 1e6)}`;
  await edgeBoard(BOARD.createDefaults, { params: { account_id }, body: { category: 'sports' } });
  // Read by its owner (edge), or only by the agent (not a visit).
  const b = await (open ? edgeBoard : via('agent', boardApp))(BOARD.getBoard, { params: { account_id } });
  return { account_id, displays: b.widgets.filter((w) => w.spec.kind === 'display') };
}
const row = (widget_id: string, account_id: string, every_s = 120, next_at = 0, active_at = 0) => ({ widget_id, kind: 'numbers' as const, account_id, every_s, next_at, active_at });
const wid = (n: number) => `wid_runload${String(n).padStart(5, '0')}`;
const acc = (n: number) => `acc_runload${String(n).padStart(5, '0')}`;

describe('schedule (A1.4.1)', () => {
  const t = Date.UTC(2026, 10, 7, 20, 0, 0);
  const opened = (m: Record<string, number | null>) => async (ids: string[]) => new Map(ids.filter((a) => a in m).map((a) => [a, m[a]!]));

  it('runs only boards opened in the last 3 hours; a user-started run counts as a visit', async () => {
    const store = new MemoryStore();
    const q: WidgetRunJob[] = [];
    const s = new Scheduler(store, async (j) => void q.push(j), () => t, opened({ [acc(1)]: t - 3600_000, [acc(2)]: t - 4 * 3600_000, [acc(3)]: null }));
    await store.schedule.put(row(wid(1), acc(1)));
    await store.schedule.put(row(wid(2), acc(2)));
    await store.schedule.put(row(wid(3), acc(3)));
    await store.schedule.put(row(wid(4), acc(4), 120, 0, t - 60_000)); // never opened, but the user refreshed a minute ago
    expect((await s.tick()).map((j) => j.widget_id).sort()).toEqual([wid(1), wid(4)]);
    // The closed boards are looked at again in the next window, not dropped.
    expect((await store.schedule.get(wid(2), 'numbers'))!.next_at).toBe(nextWindow(t, 120));
    expect(RUN_RULES.schedule.numbersOpenForMs).toBe(3 * 3600_000);
  });

  it('research for boards opened in the last day; without board, only user-started runs count', async () => {
    const store = new MemoryStore();
    const s = new Scheduler(store, async () => undefined, () => t, opened({ [acc(1)]: t - 20 * 3600_000 }));
    await store.schedule.put({ ...row(wid(1), acc(1), 3600), kind: 'research' });
    await store.schedule.put(row(wid(2), acc(1)));
    expect((await s.tick()).map((j) => j.kind)).toEqual(['research']);
    const down = new Scheduler(new MemoryStore(), async () => undefined, () => t, async () => {
      throw new Error('board down');
    });
    await down.store.schedule.put(row(wid(3), acc(3), 120, 0, t - 60_000));
    await down.store.schedule.put(row(wid(4), acc(4)));
    expect((await down.tick()).map((j) => j.widget_id)).toEqual([wid(3)]);
  });

  it('one numbers job per board per tick, with the board batch saved under its job id', async () => {
    const store = new MemoryStore();
    const q: WidgetRunJob[] = [];
    const s = new Scheduler(store, async (j) => void q.push(j), () => t, opened({ [acc(1)]: t, [acc(2)]: t }));
    for (let i = 1; i <= 6; i++) await store.schedule.put(row(wid(i), acc(1)));
    await store.schedule.put(row(wid(7), acc(2)));
    await store.schedule.put({ ...row(wid(8), acc(2), 3600), kind: 'research' });
    const jobs = await s.tick();
    expect(jobs.map((j) => [j.account_id, j.kind]).sort()).toEqual([[acc(1), 'numbers'], [acc(2), 'numbers'], [acc(2), 'research']]);
    const lead = jobs.find((j) => j.account_id === acc(1))!;
    expect((await store.batches.get(lead.job_id))!.widget_ids).toEqual([1, 2, 3, 4, 5, 6].map(wid));
    // A board with one numbers widget needs no batch.
    expect(await store.batches.get(jobs.find((j) => j.account_id === acc(2) && j.kind === 'numbers')!.job_id)).toBeNull();
    expect(await s.tick()).toEqual([]);
  });

  it('folder cards run their numbers at the slow speed; top-level displays keep their own', async () => {
    expect(everyS('numbers', { numbers_every_s: 120, research_every_s: null }, false)).toBe(120);
    expect(everyS('numbers', { numbers_every_s: 120, research_every_s: null }, true)).toBe(RUN_RULES.schedule.folderNumbersEveryS);
    expect(everyS('research', { numbers_every_s: 120, research_every_s: 3600 }, true)).toBe(3600);
    const store = new MemoryStore();
    const s = new Scheduler(store, async () => undefined, () => t);
    const card = (place: Widget['spec']['place']) =>
      ({ spec: { widget_id: wid(9), account_id: acc(9), kind: 'display', place }, profile: { cadence: { numbers_every_s: 120, research_every_s: null } } }) as unknown as Widget;
    await s.noteRun(card({ folder_id: wid(99), index: 0 }), { kind: 'numbers', reason: 'accept' });
    expect((await store.schedule.get(wid(9), 'numbers'))!.every_s).toBe(1800);
    // Moved out of the folder: the fast speed from its next run.
    await s.noteRun(card({ col: 0, row: 0 }), { kind: 'numbers', reason: 'schedule' });
    expect((await store.schedule.get(wid(9), 'numbers'))!.every_s).toBe(120);
  });

  it('a refresh in the same minute as the last run joins it, and says so', async () => {
    const { account_id, displays } = await freshBoard();
    const w = displays.find((x) => x.spec.kind === 'display' && x.spec.type === 'probability')!;
    const r = { params: { widget_id: w.spec.widget_id }, body: { account_id } };
    const first = await edgeBoard(BOARD.refresh, r);
    const again = await edgeBoard(BOARD.refresh, r);
    // createDefaults asked for this minute's numbers run already: the first refresh joins it too.
    expect(again).toEqual({ job_id: first.job_id, joined: true });
  });

  it('past the cap on manual refreshes (A1.4.2), the scheduled runs of that board still run', async () => {
    const { account_id, displays } = await freshBoard();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 5 widgets x 12 minutes: 60 refreshes, each under its widget's limit. The 61st is refused.
      for (let m = 1; m <= 12; m++) {
        vi.setSystemTime(vi.getRealSystemTime() + m * 60_000);
        for (const w of displays.slice(0, 5)) await edgeBoard(BOARD.refresh, { params: { widget_id: w.spec.widget_id }, body: { account_id } });
      }
      const refused = await edgeBoard(BOARD.refresh, { params: { widget_id: displays[5]!.spec.widget_id }, body: { account_id } }).catch((e: CallError) => e);
      expect(refused).toMatchObject({ status: 429, body: { error: 'refresh_cap' } });
    } finally {
      vi.useRealTimers();
    }
    const store = new MemoryStore();
    const q: WidgetRunJob[] = [];
    const s = new Scheduler(store, async (j) => void q.push(j), () => t, opened({ [account_id]: t - 60_000 }));
    for (const w of displays.slice(0, 6)) await store.schedule.put(row(w.spec.widget_id, account_id));
    const jobs = await s.tick();
    expect(jobs).toHaveLength(1); // one numbers job for the board's six due widgets (A1.4.1)
    expect(jobs[0]).toMatchObject({ account_id, reason: 'schedule' });
  });
});

describe('batching (A1.4.1)', () => {
  const input = (k: string, v: number): EngineInput => ({
    plan: { plan_version: 1, ops: [{ id: 'n1', op: 'implied_probability', args: { price_cents: k } }, { id: 'n2', op: 'price_to_odds', args: { price_cents: 'n1' } }] },
    numbers: { [k]: v },
    origins: { [k]: 'market' },
    provenance: { [k]: { source: 'kalshi:X', as_of: '2026-11-07T20:00:00Z' } },
  });

  it('merges inputs under one prefix per widget, and slices each widget its own numbers, receipts and errors', () => {
    const m = merge([{ input: input('price', 40), prefix: 'b0_' }, { input: input('price', 70), prefix: 'b1_' }]);
    expect(m.plan.ops.map((o) => [o.id, o.args])).toEqual([
      ['b0_n1', { price_cents: 'b0_price' }],
      ['b0_n2', { price_cents: 'b0_n1' }],
      ['b1_n1', { price_cents: 'b1_price' }],
      ['b1_n2', { price_cents: 'b1_n1' }],
    ]);
    expect(m.numbers).toEqual({ b0_price: 40, b1_price: 70 });
    expect(Object.keys(m.provenance!)).toEqual(['b0_price', 'b1_price']);
    const num = (id: string) => ({ id, op: 'implied_probability' as const, receipt_id: `r-${id}`, unit: 'probability' as const, value: 0.4 });
    const er = {
      engine_version: 'x', git_hash: 'x', input_hash: 'x', plan_hash: 'h', ok: false, plan: m.plan,
      numbers: [num('b0_n1'), num('b1_n1')],
      receipts: [{ id: 'r-b0_n1', op_id: 'b0_n1' }, { id: 'r-b1_n1', op_id: 'b1_n1' }],
      errors: [{ op_id: 'b1_n2', code: 'bad_arg', message: 'x' }, { op_id: 'plan', code: 'bad_plan', message: 'y' }],
    } as unknown as EngineResult;
    const b1 = slice(er, 'b1_');
    expect(b1.numbers.map((n) => [n.id, n.receipt_id])).toEqual([['n1', 'r-b1_n1']]);
    expect(b1.receipts.map((r) => r.id)).toEqual(['r-b1_n1']);
    expect(b1.errors.map((e) => e.op_id)).toEqual(['n2', 'plan']);
    expect(slice(er, 'b0_').errors.map((e) => e.op_id)).toEqual(['plan']);
  });

  it('one box for every widget that hands in an input; a widget that finishes without one does not hold it up', async () => {
    const boxes: EngineInput[] = [];
    const runner: ComputeRunner = {
      computeOne: async (_s, i) => {
        boxes.push(i);
        return { job_id: 'x', sandbox_id: 'sbx', state: 'failed', trust_log: [] } as unknown as SbxJobStatus;
      },
    };
    const b = new ComputeBatch(3, 60_000);
    const spec = {} as never;
    const [s0, s1, s2] = [b.slot(0), b.slot(1), b.slot(2)];
    const p0 = s0.compute(runner, spec, input('price', 40));
    s1.leave(); // e.g. a positions widget with no connection
    const p2 = s2.compute(runner, spec, input('price', 70));
    await Promise.all([p0, p2]);
    expect(b.boxes).toBe(1);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.plan.ops).toHaveLength(4);
  });

  it("after the wait, the batch goes without a late widget, which computes alone", async () => {
    const runner: ComputeRunner = { computeOne: async () => null };
    const b = new ComputeBatch(2, 20);
    await b.slot(0).compute(runner, {} as never, input('price', 40));
    await b.slot(1).compute(runner, {} as never, input('price', 70));
    expect(b.boxes).toBe(2);
  });
});

// ---------- on the real sandbox-manager (stub backend) ----------

let manager: ChildProcess | undefined;
let sandbox: SandboxClient;

beforeAll(async () => {
  if (!have) return;
  manager = spawn(MANAGER, ['serve'], {
    env: { ...process.env, SANDBOX_MANAGER_ADDR: `127.0.0.1:${PORT}`, SANDBOX_MANAGER_CALLERS: `runner:${hashToken(TEST_TOKENS.runner)}`, SANDBOX_MANAGER_DEV: '1' },
    stdio: 'ignore',
  });
  sandbox = sandboxClient({ baseUrl: `http://127.0.0.1:${PORT}`, token: TEST_TOKENS.runner });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sandbox-manager did not start');
}, 30_000);
afterAll(() => {
  manager?.kill('SIGTERM');
});

/** The deps, with every compute box created counted by board (account), for numbers runs (and research runs' in `research`). */
function deps(boxes: Map<string, number>, research = new Map<string, number>()) {
  const store = new MemoryStore();
  const counted: SandboxClient = {
    ...sandbox,
    createJob: async (req) => {
      const j = await sandbox.createJob(req);
      if (req.kind === 'compute') {
        const acc = owner.get(req.widget_id)!;
        const m = store.runs.get(req.run_id)?.kind === 'research' ? research : boxes;
        m.set(acc, (m.get(acc) ?? 0) + 1);
      }
      return j;
    },
  };
  const d: RunnerDeps = {
    board: runnerBoard,
    markets: via('runner', marketsApp),
    models: via('runner', fakeApp('models', MODELS, modelsFake())),
    connections: via('runner', fakeApp('connections', CONNECTIONS, connectionsFake())),
    sandbox: counted,
    bus: new MemoryBus(),
    audit: async (e) => audit.append(e).row_id,
    store,
    sourceEnv: 'fixture',
    pollMs: 10,
  };
  return { d, store };
}
const owner = new Map<string, string>();

/**
 * Runs jobs `slots` at a time, as the widget-runs worker does (QUEUE_RULES concurrency). A busy answer puts the job
 * back after its wait without spending an attempt, as the queue does. Returns the other errors and the busy waits.
 */
async function drain(d: RunnerDeps, jobs: WidgetRunJob[], slots = RUN_RULES.sandboxSlots, together?: AccountBatches) {
  const queue = [...jobs];
  const errors: unknown[] = [];
  let busy = 0;
  let waiting = 0;
  await Promise.all(
    Array.from({ length: slots }, async () => {
      for (;;) {
        const j = queue.shift();
        if (!j) {
          if (!waiting) return;
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        await runJob(d, j, ctx(), together).catch(async (e) => {
          if (!(e instanceof SandboxBusy)) return void errors.push(e);
          busy++;
          waiting++;
          await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs, 500)));
          waiting--;
          queue.push(j);
        });
      }
    }),
  );
  return { errors, busy };
}

/** Twenty-odd boards' schedules booked as after their first runs, all due at `t`. */
async function boards(n: number, s: Scheduler) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = await freshBoard();
    for (const w of b.displays) {
      owner.set(w.spec.widget_id, b.account_id);
      await s.noteRun(w, { kind: 'numbers', reason: 'schedule' });
    }
    out.push(b);
  }
  return out;
}
const numbersRuns = (store: MemoryStore) => [...store.runs.values()].filter((r) => r.kind === 'numbers');
const timedOut = (rs: RunRecord[]) => rs.filter((r) => r.steps.some((s) => s.note?.includes('timed out')));

describe.skipIf(!have)('runs fit the machine (stub sandbox-manager)', () => {
  it("one board's batch: one compute box, and every widget its own run, receipts and published result", async () => {
    const boxes = new Map<string, number>();
    const { d, store } = deps(boxes);
    const b = await freshBoard();
    b.displays.forEach((w) => owner.set(w.spec.widget_id, b.account_id));
    const ids = b.displays.map((w) => w.spec.widget_id);
    const created0 = audit.rows.filter((r) => r.entry.action === TRUST_ACTIONS.sandboxCreated).length;
    const lead: WidgetRunJob = { job_id: `${ids[0]}:numbers:1794096000`, widget_id: ids[0]!, account_id: b.account_id, kind: 'numbers', window_start: 1794096000, reason: 'schedule' };
    await store.batches.put({ job_id: lead.job_id, account_id: b.account_id, widget_ids: ids });
    const r = await runJob(d, lead, ctx());
    expect(r.runs).toBe(ids.length);
    expect(boxes.get(b.account_id)).toBe(1);
    // The box's trust rows once: one created, one destroyed.
    const created = audit.rows.filter((r) => r.entry.action === TRUST_ACTIONS.sandboxCreated).length - created0;
    expect(created).toBe(1);
    const runs = numbersRuns(store);
    expect(runs.map((x) => x.status).every((s) => s === 'done')).toBe(true);
    const math = runs.flatMap((x) => x.steps.filter((s) => s.step === 'math' && s.status === 'ok'));
    expect(math.length).toBeGreaterThan(1);
    expect(new Set(math.map((s) => s.sandbox?.sandbox_id)).size).toBe(1);
    // Each published widget has its own receipts, and the same numbers a run of its own computes.
    const solo = deps(new Map());
    const seen = new Set<string>();
    for (const w of b.displays) {
      const cur = (await runnerBoard(BOARD.getWidget, { params: { widget_id: w.spec.widget_id }, query: { account_id: b.account_id } })).result;
      if (!cur) continue;
      expect(cur.numbers.every((n) => cur.receipts.some((x) => x.id === n.receipt_id))).toBe(true);
      for (const x of cur.receipts) {
        expect(seen.has(x.id)).toBe(false);
        seen.add(x.id);
      }
      const alone = await handleRun(solo.d, { ...lead, reason: 'refresh', widget_id: w.spec.widget_id, job_id: `${w.spec.widget_id}:numbers:1794096060`, window_start: 1794096060 }, ctx());
      expect(alone.status).toBe('done');
      const again = (await runnerBoard(BOARD.getWidget, { params: { widget_id: w.spec.widget_id }, query: { account_id: b.account_id } })).result!;
      expect(again.numbers.map((n) => [n.id, n.op, n.value])).toEqual(cur.numbers.map((n) => [n.id, n.op, n.value]));
    }
  }, 60_000);

  it("sign-up: a new board's first numbers runs (one job per display) share boxes per account in the worker", async () => {
    const boxes = new Map<string, number>();
    const { d, store } = deps(boxes);
    const users = await boards(5, new Scheduler(new MemoryStore(), async () => undefined));
    const jobs = users.flatMap((b) =>
      b.displays.map((w) => ({ job_id: `${w.spec.widget_id}:numbers:1794096000`, widget_id: w.spec.widget_id, account_id: b.account_id, kind: 'numbers' as const, window_start: 1794096000, reason: 'accept' as const })),
    );
    const { errors } = await drain(d, jobs, RUN_RULES.sandboxSlots, new AccountBatches());
    expect(errors).toEqual([]);
    const runs = numbersRuns(store);
    expect(runs).toHaveLength(jobs.length);
    expect(runs.filter((r) => r.status !== 'done')).toEqual([]);
    const per = users.map((u) => boxes.get(u.account_id) ?? 0);
    console.info(`A1.4.1 sign-up: ${JSON.stringify({ runs_per_board: users[0]!.displays.length, boxes_per_board: per })}`);
    // Six worker slots: about one box per six runs of a board, never one per run.
    expect(Math.max(...per)).toBeLessThanOrEqual(Math.ceil(users[0]!.displays.length / 2));
  }, 120_000);

  it('load: twenty users ticked together run with no timeouts, at most a few boxes per board per tick (was one per display)', async () => {
    const t0 = Date.now();
    // Before (one job and one box per due display, as main did before A1.4.1), on three boards.
    const before = new Map<string, number>();
    const pre = deps(before);
    const old = await boards(3, new Scheduler(pre.store, async () => undefined));
    const oldJobs = old.flatMap((b) => b.displays.map((w) => ({ job_id: `${w.spec.widget_id}:numbers:1794096000`, widget_id: w.spec.widget_id, account_id: b.account_id, kind: 'numbers' as const, window_start: 1794096000, reason: 'schedule' as const })));
    const was = await drain(pre.d, oldJobs);

    // After: twenty boards, one tick, their jobs through the worker's six slots.
    const boxes = new Map<string, number>();
    const research = new Map<string, number>();
    const { d, store } = deps(boxes, research);
    let t = Date.now();
    const q: WidgetRunJob[] = [];
    const s = new Scheduler(store, async (j) => void q.push(j), () => t, openedFrom(runnerBoard));
    const users = await boards(20, s);
    t = nextWindow(t, RUN_RULES.schedule.folderNumbersEveryS) + 1000; // every cadence (fast and slow) is due
    const jobs = await s.tick();
    const { errors, busy } = await drain(d, jobs);
    const runs = numbersRuns(store);
    const perBoard = users.map((u) => boxes.get(u.account_id) ?? 0);
    const report = {
      displays_per_board: users[0]!.displays.length,
      boxes_per_board_before: old.map((b) => before.get(b.account_id) ?? 0),
      numbers_boxes_per_board_after: perBoard,
      research_compute_boxes_per_board_after: users.map((u) => research.get(u.account_id) ?? 0),
      jobs_after: jobs.length,
      busy_waits_before: was.busy,
      busy_waits_after: busy,
      runs_after: runs.length,
      failed: runs.filter((r) => r.status === 'failed').length,
      timed_out: timedOut(runs).length,
      ms: Date.now() - t0,
    };
    console.info(`A1.4.1 load: ${JSON.stringify(report)}`);
    if (process.env.RUNLOAD_REPORT) writeFileSync(process.env.RUNLOAD_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    expect(errors).toEqual([]);
    expect(report.timed_out).toBe(0);
    expect(report.failed).toBe(0);
    expect(jobs.filter((j) => j.kind === 'numbers')).toHaveLength(20);
    // One numbers box per board; with its research run's math (the news widget, due in the same tick) at most 2.
    expect(Math.max(...perBoard)).toBeLessThanOrEqual(1);
    expect(Math.max(...users.map((u) => perBoard[users.indexOf(u)]! + (research.get(u.account_id) ?? 0)))).toBeLessThanOrEqual(2);
    expect(Math.min(...report.boxes_per_board_before)).toBeGreaterThan(Math.max(...perBoard));
  }, 300_000);
});
