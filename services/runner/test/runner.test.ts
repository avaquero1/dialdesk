/**
 * runner's steps on the fakes (board, markets, models, audit) and the real sandbox-manager binary on its stub backend:
 * a numbers run, a research run with a poisoned page, the guard's `unchecked`, keep-the-last-clean-result, the slot
 * summary blocked for advice, busy and resume, the planner's plan checked against the catalog, the timeout, and the
 * scheduler. Needs target/debug/sandbox-manager (make check builds it first); without it the suite is skipped.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD, CONNECTIONS, MARKETS, MODELS, POISONED_NOTE, TRUST_ACTIONS, newId, widgetRunJobId, type CompleteBody, type LogEntry, type RunKind, type SbxJobStatus as SbxJob, type Widget, type WidgetRunJob } from '@app/contracts';
import { MemoryBus, NoRetry, SandboxBusy, createClient, hashToken, sandboxClient, type Call, type SandboxClient } from '@app/service-kit';
import { fakeApp, fixtures, pageText, TEST_TOKENS } from '@app/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeAudit } from '../../audit/src/fake.ts';
import { fake as boardFake } from '../../board/src/fake.ts';
import { fake as connectionsFake } from '../../connections/src/fake.ts';
import { fake as marketsFake } from '../../markets/src/fake.ts';
import { fake as modelsFake } from '../../models/src/fake.ts';
import { getRunHandlers } from '../src/real.ts';
import { handleRun, type RunnerDeps } from '../src/run.ts';
import { ACTIVE_FOR_MS, Scheduler } from '../src/scheduler.ts';
import { MemoryStore } from '../src/store.ts';

const MANAGER = join(import.meta.dirname, '../../../target/debug/sandbox-manager');
const PORT = 19200 + (process.pid % 500);
const have = existsSync(MANAGER);
if (!have) console.warn(`runner tests skipped: build ${MANAGER} first (make rust)`);

let manager: ChildProcess | undefined;
let sandbox: SandboxClient;

const marketsApp = fakeApp('markets', MARKETS, marketsFake());
const via = (caller: keyof typeof TEST_TOKENS, app: { fetch: (r: Request) => Response | Promise<Response> }) =>
  createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });
const boardApp = fakeApp('board', BOARD, boardFake({ markets: via('board', marketsApp), enqueue: () => undefined }));
const modelsApp = fakeApp('models', MODELS, modelsFake());
const connectionsApp = fakeApp('connections', CONNECTIONS, connectionsFake());
const edgeBoard = via('edge', boardApp);
const audit = createFakeAudit();

/** The models fake as runner, with a scenario forced per role (the real models ignore `scenario`). */
function models(force: Partial<Record<CompleteBody['role'], CompleteBody['scenario']>> = {}, seen: CompleteBody[] = []): Call {
  const call = via('runner', modelsApp);
  return (async (e, input) => {
    const body = { ...(input as { body: CompleteBody }).body };
    seen.push(body);
    if (force[body.role]) body.scenario = force[body.role];
    return call(e, { body } as never);
  }) as Call;
}

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps & { bus: MemoryBus; store: MemoryStore } {
  return {
    board: via('runner', boardApp),
    markets: via('runner', marketsApp),
    models: models(),
    connections: via('runner', connectionsApp),
    sandbox,
    bus: new MemoryBus(),
    audit: async (e) => audit.append(e).row_id,
    store: new MemoryStore(),
    sourceEnv: 'fixture',
    pageText: (url) => {
      const p = fixtures.manifest().find((x) => x.url === url);
      return p ? pageText(fixtures.page(p.file)) : null;
    },
    pollMs: 10,
    ...over,
  } as RunnerDeps & { bus: MemoryBus; store: MemoryStore };
}

const ctx = (attempt = 1, signal = new AbortController().signal) => ({ jobId: 'j', attempt, signal });
const jobFor = (w: Widget, kind: RunKind, reason: WidgetRunJob['reason'] = 'accept', at = Date.now()): WidgetRunJob => {
  const window_start = Math.floor(at / 1000);
  return { job_id: widgetRunJobId(w.spec.widget_id, kind, window_start), widget_id: w.spec.widget_id, account_id: w.spec.account_id, kind, window_start, reason };
};
let seq = 0;
/** A fresh default board; returns its displays by title. */
async function freshBoard() {
  const account_id = `acc_runnertest${String(++seq).padStart(4, '0')}${Math.floor(Math.random() * 1e6)}`;
  const b = await edgeBoard(BOARD.createDefaults, { params: { account_id }, body: { category: 'sports' } });
  const byTitle = (t: string) => b.widgets.find((w) => w.spec.title === t)!;
  return { account_id, byTitle };
}
const current = async (w: Widget) => via('runner', boardApp)(BOARD.getWidget, { params: { widget_id: w.spec.widget_id }, query: { account_id: w.spec.account_id } });

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

describe.skipIf(!have)('runner', () => {
  it('a numbers run: market prices into a compute sandbox, receipts tagged by origin, no model call', async () => {
    const seen: CompleteBody[] = [];
    const d = deps({ models: models({}, seen) });
    const { byTitle } = await freshBoard();
    const w = byTitle('Chiefs beat the Bills');
    const job = jobFor(w, 'numbers');
    const rec = await handleRun(d, job, ctx());
    expect(rec.status).toBe('done');
    expect(rec.steps.map((s) => [s.step, s.status])).toEqual([
      ['math', 'ok'],
      ['guard', 'ok'],
      ['publish', 'ok'],
    ]);
    expect(seen).toEqual([]);
    const r = (await current(w)).result!;
    expect(r.numbers.map((n) => n.op)).toEqual(['implied_probability', 'implied_probability', 'expected_value', 'movement']);
    const ev = r.receipts.find((x) => x.op === 'expected_value')!;
    expect([...ev.origins!].sort()).toEqual(['market', 'user']);
    expect(r.receipts.find((x) => x.op === 'movement')!.origins).toContain('history');
    expect(d.bus.events.map((e) => e.event)).toEqual(['run.started', 'run.step', 'run.step', 'run.step']);
    const got = await getRunHandlers(d.store).getRun({ params: { run_id: rec.run_id } } as never, {} as never);
    expect(got).toMatchObject({ run_id: rec.run_id, status: 'done', last_step: 'publish' });
    // A second delivery of the same job doesn't run it again.
    const again = await handleRun(d, job, ctx());
    expect(again.run_id).toBe(rec.run_id);
    expect(again.steps).toHaveLength(3);
    expect(d.bus.events).toHaveLength(4);
  });

  it("positions: numbers from connections only with the user's consent (403 = not connected), tagged `connection`", async () => {
    const { account_id, byTitle } = await freshBoard();
    const w = byTitle('Positions');
    const edgeConn = via('edge', connectionsApp);
    const con = await edgeConn(CONNECTIONS.connect, {
      body: { account_id, exchange: 'kalshi', key_id: 'fixture-key-1', key_type: 'ed25519', sealed_key: 'c2VhbGVkLWJveC1ieXRlcy1mb3ItdGVzdHM=', env: 'demo' },
    } as never);
    // board's spec carries the connection id once the user connects; here it is set on the widget board answers.
    const board = via('runner', boardApp);
    const withConn: Call = (async (e, input) => {
      const out = (await board(e, input as never)) as unknown;
      if ((e as unknown) !== BOARD.getWidget) return out;
      const got = out as Widget;
      return { ...got, spec: { ...got.spec, params: { connection_id: con.connection_id } } };
    }) as Call;
    const d = deps({ board: withConn });
    const no = await handleRun(d, jobFor(w, 'numbers'), ctx());
    expect(no.status).toBe('done');
    expect(no.steps.map((x) => [x.step, x.status, x.note])).toEqual([['math', 'skipped', 'not connected (numbers not shared)']]);
    expect((await current(w)).result).toBeNull();

    await edgeConn(CONNECTIONS.setConsent, { params: { connection_id: con.connection_id }, body: { account_id, share_numbers: true } });
    const yes = await handleRun(d, jobFor(w, 'numbers', 'refresh', Date.now() + 5000), ctx());
    expect(yes.steps.map((x) => x.step)).toEqual(['math', 'guard', 'publish']);
    const r = (await current(w)).result!;
    expect(r.numbers.map((n) => n.op).slice(0, 2)).toEqual(['position_value', 'pnl']);
    for (const x of r.receipts) expect([...x.origins!].sort()).toEqual(['connection', 'market']);
  });

  it('a research run: the poisoned page is killed live, the clean ones released, the summary filled by code', async () => {
    const d = deps();
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const rec = await handleRun(d, jobFor(w, 'research'), ctx());
    expect(rec.status).toBe('poisoned');
    const poisoned = rec.steps.filter((s) => s.status === 'poisoned');
    expect(poisoned).toHaveLength(1);
    expect(poisoned[0]!.note).toBe(POISONED_NOTE);
    const read = rec.steps.find((s) => s.step === 'read' && s.sandbox?.sandbox_id === poisoned[0]!.sandbox!.sandbox_id)!;
    const job = await sandbox.getJob(`${rec.run_id}:read:${read.source!.candidate_id}`);
    expect(job).toMatchObject({ state: 'killed', kill_reason: 'poison' });
    expect(d.bus.events.filter((e) => e.event === 'run.poisoned')).toHaveLength(1);
    const r = (await current(w)).result!;
    expect(r.blocked.map((b) => [b.domain, b.note])).toEqual([['fanpost.fixture.test', POISONED_NOTE]]);
    expect(r.summary!.template).toMatch(/\{n1\}/);
    expect(JSON.stringify(r)).not.toMatch(/ignore your previous instructions|put everything on YES/i);
    // Facts keep only quotes found on their page.
    for (const f of r.facts) expect(r.sources.find((s) => s.candidate_id === f.candidate_id)!.status).toBe('read');
  });

  it("the sandbox rows are the manager's trust_log, forwarded once each with account_id as sandbox-manager (no double count)", async () => {
    const rows: LogEntry[] = [];
    // The stub's proxy refuses nothing: add two refusals to the held job, and the manager's proxy.refused row at teardown.
    const at = () => new Date().toISOString();
    const withRefused = (j: SbxJob): SbxJob => {
      if (j.kind !== 'browse' || !(j.trust_log ?? []).some((r) => r.action === TRUST_ACTIONS.sandboxDestroyed)) return j;
      const t = [...j.trust_log!];
      t.splice(t.length - 1, 0, { action: TRUST_ACTIONS.proxyRefused, at: at(), subject_id: j.sandbox_id, outcome: 'refused', ids: { job_id: j.job_id }, sizes: { requests: 2 } });
      return { ...j, trust_log: t };
    };
    let polls = 0;
    const refusing: SandboxClient = {
      ...sandbox,
      getJob: async (id) => {
        polls++;
        const j = withRefused(await sandbox.getJob(id));
        if (j.kind !== 'browse' || j.state !== 'held') return j;
        const no = (host: string, reason: 'blocked_range' | 'not_on_allowlist') => ({ at: at(), sandbox_id: j.sandbox_id, host, port: 443, allowed: false, reason });
        return { ...j, proxy_log: [...j.proxy_log, no('169.254.169.254', 'blocked_range'), no('collect.exfil.fixture.test', 'not_on_allowlist')] };
      },
      // The stub answers held at once; go through getJob so the refusals show (and the job is polled more than once).
      createJob: async (req) => ({ ...(await sandbox.createJob(req)), state: 'queued' }),
      release: async (id) => withRefused(await sandbox.release(id)),
      kill: async (id, reason, row) => withRefused(await sandbox.kill(id, reason, row)),
    };
    const d = deps({ sandbox: refusing, audit: async (e) => (rows.push(e), audit.append(e).row_id) });
    const { account_id, byTitle } = await freshBoard();
    const rec = await handleRun(d, jobFor(byTitle('Bills news'), 'research'), ctx());
    const n = (a: string) => rows.filter((r) => r.action === a);
    const reads = rec.steps.filter((x) => x.step === 'read' && x.status === 'ok').length;
    expect(polls).toBeGreaterThan(reads);
    expect(n(TRUST_ACTIONS.proxyRefused)).toHaveLength(reads);
    expect(n(TRUST_ACTIONS.proxyRefused).every((r) => r.sizes.requests === 2)).toBe(true);
    // One created and one destroyed row per sandbox (browse + compute); the poisoned one is killed, then destroyed too.
    expect(n(TRUST_ACTIONS.sandboxCreated)).toHaveLength(reads + 1);
    expect(n(TRUST_ACTIONS.sandboxDestroyed)).toHaveLength(reads + 1);
    expect(n(TRUST_ACTIONS.sandboxKilled).map((r) => r.ids.reason)).toEqual(['poison']);
    expect(new Set(n(TRUST_ACTIONS.sandboxCreated).map((r) => r.subject_id)).size).toBe(reads + 1);
    // Every sandbox row came from the manager, not from runner, and carries the account.
    const sbx = rows.filter((r) => r.action.startsWith('sandbox.') || r.action.startsWith('proxy.'));
    expect(sbx.every((r) => r.service === 'sandbox-manager' && r.account_id === account_id && r.ids.run_id === rec.run_id)).toBe(true);
    expect(rows.filter((r) => r.service === 'runner' && (r.action.startsWith('sandbox.') || r.action.startsWith('proxy.')))).toEqual([]);
    // The kill row links the run.poisoned row that asked for it.
    expect(n(TRUST_ACTIONS.sandboxKilled)[0]!.ids.audit_row_id).toEqual(expect.any(String));
    expect(n(TRUST_ACTIONS.runPoisoned)[0]!.ids.sandbox_id).toMatch(/^sbx-/);
    expect(n('run.started')).toHaveLength(1);
    expect(n('result.published')[0]!.ids.result_id).toMatch(/^res_/);
    expect(rec.steps.find((x) => x.step === 'read')!.proxy!.refused).toBe(2);
    expect(JSON.stringify(rows)).not.toMatch(/ignore your previous instructions|exfil\.fixture/i);
  });

  it('forwarding is idempotent: the same trust_log seen again (a retry, a second poll) logs nothing new', async () => {
    const rows: LogEntry[] = [];
    // Queued at first: runner polls the job (and its trust_log) several times before it ends.
    const polled: SandboxClient = { ...sandbox, createJob: async (req) => ({ ...(await sandbox.createJob(req)), state: 'queued' }) };
    const d = deps({ sandbox: polled, audit: async (e) => (rows.push(e), audit.append(e).row_id) });
    const { byTitle } = await freshBoard();
    const w = byTitle('Chiefs beat the Bills');
    const job = jobFor(w, 'numbers');
    const rec = await handleRun(d, job, ctx());
    const first = rows.filter((r) => r.service === 'sandbox-manager').map((r) => r.action);
    expect(first).toEqual([TRUST_ACTIONS.sandboxCreated, TRUST_ACTIONS.sandboxDestroyed]);
    expect((rec.outputs as { trust?: Record<string, number> }).trust).toEqual({ [`${rec.run_id}:math`]: 2 });
    await handleRun(d, job, ctx());
    expect(rows.filter((r) => r.service === 'sandbox-manager').map((r) => r.action)).toEqual(first);
  });

  it('the planner sees ids, domains and dates only; a plan outside the catalog is refused for the default', async () => {
    const seen: CompleteBody[] = [];
    const d = deps({ models: models({}, seen) });
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const rec = await handleRun(d, jobFor(w, 'research'), ctx());
    const planner = seen.find((b) => b.role === 'planner')!;
    const input = JSON.parse(planner.messages.at(-1)!.content) as { candidates: Record<string, unknown>[]; allowed_ops: string[] };
    for (const c of input.candidates) expect(Object.keys(c).sort()).toEqual(['date', 'domain', 'id']);
    expect(input.allowed_ops).not.toContain('base_rate_history');
    expect(JSON.stringify(planner.messages)).not.toMatch(/questionable|momentum|title_for_user/i);
    // The fake planner asks for `gap`, which isn't a news op.
    expect(rec.steps.find((s) => s.step === 'plan')!.note).toMatch(/refused \(op gap/);
  });

  it("an `unchecked` extract (the guard model failed) releases the sandbox and drops the facts, with no poison", async () => {
    const d = deps({ models: models({ guard: 'error' }) });
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const rec = await handleRun(d, jobFor(w, 'research'), ctx()).catch((e) => e);
    // Layer one is sure about the poisoned page, so that one is still killed; the clean pages are unchecked.
    const extracts = (rec as { steps?: { step: string; status: string; note: string | null; sandbox: { state: string } | null }[] }).steps!.filter((s) => s.step === 'extract');
    const unchecked = extracts.filter((s) => s.note?.startsWith('guard could not check'));
    expect(unchecked.length).toBeGreaterThan(0);
    for (const s of unchecked) expect(s.sandbox!.state).toBe('released');
    expect(d.bus.events.filter((e) => e.event === 'run.poisoned').length).toBeLessThanOrEqual(1);
  });

  it('poisoned with nothing clean: the widget keeps its last clean result, with the note', async () => {
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    await handleRun(deps(), jobFor(w, 'research'), ctx());
    const before = (await current(w)).result!;
    expect(before.facts.length).toBeGreaterThan(0);
    const d = deps({ models: models({ reader: 'poisoned' }) });
    const rec = await handleRun(d, jobFor(w, 'research', 'refresh', Date.now() + 5000), ctx());
    expect(rec.status).toBe('poisoned');
    const after = (await current(w)).result!;
    expect(after.run_id).toBe(rec.run_id);
    expect(after.facts).toEqual(before.facts);
    expect(after.summary).toEqual(before.summary);
    expect(after.blocked.length).toBeGreaterThan(1);
    expect(after.blocked.every((b) => b.note === POISONED_NOTE)).toBe(true);
  });

  it('advice in the summary: the guard blocks it and the result goes out without the summary', async () => {
    const d = deps({ models: models({ summarizer: 'advice' }) });
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const rec = await handleRun(d, jobFor(w, 'research'), ctx());
    expect(rec.steps.find((s) => s.step === 'guard')!.note).toMatch(/^summary blocked: .*advice/);
    const r = (await current(w)).result!;
    expect(r.summary).toBeNull();
    expect(r.facts.length).toBeGreaterThan(0);
  });

  it('busy at compute: the job waits without an attempt, then resumes from the saved steps', async () => {
    let busy = true;
    const flaky: SandboxClient = {
      ...sandbox,
      createJob: async (req) => {
        if (req.kind === 'compute' && busy) {
          busy = false;
          throw new SandboxBusy(500);
        }
        return sandbox.createJob(req);
      },
    };
    const seen: CompleteBody[] = [];
    const d = deps({ sandbox: flaky, models: models({}, seen) });
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const job = jobFor(w, 'research');
    await expect(handleRun(d, job, ctx())).rejects.toBeInstanceOf(SandboxBusy);
    const mid = [...d.store.runs.values()][0]!;
    expect(mid.status).toBe('running');
    expect(mid.last_step).toBe('extract');
    const readers = seen.filter((b) => b.role === 'reader').length;
    const rec = await handleRun(d, job, ctx());
    expect(rec.run_id).toBe(mid.run_id);
    expect(['done', 'poisoned']).toContain(rec.status);
    expect(rec.steps.filter((s) => s.step === 'sources')).toHaveLength(1);
    expect(seen.filter((b) => b.role === 'reader').length).toBe(readers);
    expect(d.bus.events.filter((e) => e.event === 'run.started')).toHaveLength(1);
  });

  it('a timeout ends the run as failed with run.failed, and nothing stays held', async () => {
    const d = deps();
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const ac = new AbortController();
    ac.abort(new NoRetry('timeout'));
    await expect(handleRun(d, jobFor(w, 'research'), ctx(1, ac.signal))).rejects.toThrow();
    const rec = [...d.store.runs.values()][0]!;
    expect(rec.status).toBe('failed');
    expect(d.bus.events.find((e) => e.event === 'run.failed')!.payload).toMatchObject({ reason: 'timeout' });
    expect((await sandbox.sandboxes()).sandboxes.filter((s) => s.state === 'held' && s.job_id.startsWith(rec.run_id))).toEqual([]);
  });

  it('a widget board no longer has: no retry, and its schedule is dropped', async () => {
    const store = new MemoryStore();
    const gone: string[] = [];
    const d = deps({ store, onWidgetGone: async (id) => void gone.push(id) });
    const widget_id = newId('wid');
    const job: WidgetRunJob = { job_id: widgetRunJobId(widget_id, 'numbers', 1), widget_id, account_id: newId('acc'), kind: 'numbers', window_start: 1, reason: 'schedule' };
    await expect(handleRun(d, job, ctx())).rejects.toBeInstanceOf(NoRetry);
    expect(gone).toEqual([widget_id]);
  });
});

describe('scheduler', () => {
  const widget = (numbers: number | null, research: number | null): Widget =>
    ({
      spec: { widget_id: 'wid_sched0000001', account_id: 'acc_sched0000001', kind: 'display' },
      profile: { cadence: { numbers_every_s: numbers, research_every_s: research } },
    }) as unknown as Widget;

  it('books each kind from the cadence and enqueues it once per window', async () => {
    let t = Date.UTC(2026, 10, 7, 15, 0, 30);
    const store = new MemoryStore();
    const q: WidgetRunJob[] = [];
    const s = new Scheduler(store, async (j) => void q.push(j), () => t);
    await s.noteRun(widget(120, 3600), { kind: 'numbers', reason: 'accept' });
    expect(await s.tick()).toEqual([]);
    t += 120_000;
    const first = await s.tick();
    expect(first.map((j) => [j.kind, j.reason])).toEqual([['numbers', 'schedule']]);
    expect(first[0]!.job_id).toBe(`wid_sched0000001:numbers:${first[0]!.window_start}`);
    expect(await s.tick()).toEqual([]);
    t += 3600_000;
    expect((await s.tick()).map((j) => j.kind).sort()).toEqual(['numbers', 'research']);
  });

  it('research stops on an idle board (no user-started run in a day); numbers go on', async () => {
    let t = Date.UTC(2026, 10, 7, 15, 0, 0);
    const store = new MemoryStore();
    const s = new Scheduler(store, async () => undefined, () => t);
    await s.noteRun(widget(300, 3600), { kind: 'research', reason: 'accept' });
    t += ACTIVE_FOR_MS + 3600_000;
    expect((await s.tick()).map((j) => j.kind)).toEqual(['numbers']);
    await s.noteRun(widget(300, 3600), { kind: 'numbers', reason: 'refresh' });
    t += 3600_000;
    expect((await s.tick()).map((j) => j.kind).sort()).toEqual(['numbers', 'research']);
  });

  it('a cadence turned off removes that kind', async () => {
    const store = new MemoryStore();
    const s = new Scheduler(store, async () => undefined);
    await s.noteRun(widget(120, 3600), { kind: 'numbers', reason: 'accept' });
    await s.noteRun(widget(120, null), { kind: 'numbers', reason: 'schedule' });
    expect(await store.schedule.get('wid_sched0000001', 'research')).toBeNull();
    expect(await store.schedule.get('wid_sched0000001', 'numbers')).not.toBeNull();
  });
});
