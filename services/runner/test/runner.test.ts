/**
 * runner's steps on the fakes (board, markets, models, audit) and the real sandbox-manager binary on its stub backend:
 * a numbers run, a research run with a poisoned page, the guard's `unchecked`, keep-the-last-clean-result, the slot
 * summary blocked for advice, busy and resume, the planner's plan checked against the catalog, the timeout, and the
 * scheduler. Needs target/debug/sandbox-manager (make check builds it first); without it the suite is skipped.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD, CONNECTIONS, MARKETS, MODELS, POISONED_NOTE, TRUST_ACTIONS, newId, widgetRunJobId, type CompleteBody, type LogEntry, type RunKind, type SbxJobStatus as SbxJob, type Verdict, type Widget, type WidgetRunJob } from '@app/contracts';
import { MemoryBus, NoRetry, SandboxBusy, createClient, hashToken, sandboxClient, type Call, type SandboxClient } from '@app/service-kit';
import { fakeApp, fixtures, pageText, sampleResult, TEST_TOKENS } from '@app/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeAudit } from '../../audit/src/fake.ts';
import { fake as boardFake } from '../../board/src/fake.ts';
import { fake as connectionsFake } from '../../connections/src/fake.ts';
import { fake as marketsFake } from '../../markets/src/fake.ts';
import { fake as modelsFake } from '../../models/src/fake.ts';
import { getRunHandlers } from '../src/real.ts';
import { LINE_POINTS, defaultPlan, isBiggestMove, lineAgo, moverIds } from '../src/plans.ts';
import { handleRun, layerOneGuard, modelGuard, type Guard, type RunnerDeps } from '../src/run.ts';
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
    expect(r.numbers.map((n) => n.op)).toEqual(['implied_probability', 'implied_probability', 'expected_value', 'movement', ...Array(LINE_POINTS).fill('price_at'), 'base_rate_history', 'base_rate_history']);
    const ev = r.receipts.find((x) => x.op === 'expected_value')!;
    expect([...ev.origins!].sort()).toEqual(['market', 'user']);
    expect(r.receipts.find((x) => x.op === 'movement')!.origins).toContain('history');
    // Every price and series carries its market and time; the move is since yesterday, the line spans the 7 days.
    const spec = w.spec.kind === 'display' ? w.spec : null;
    const quote = await via('runner', marketsApp)(MARKETS.get, { params: { market_id: spec!.market_ids[0]! } });
    expect(r.receipts[0]!.provenance).toEqual({ price_cents: { source: quote.market_id, as_of: quote.as_of } });
    const move = r.receipts.find((x) => x.op === 'movement')!;
    expect(move.args.window_s).toBe(86400);
    expect(move.provenance?.series?.source).toBe(spec!.market_ids[0]);
    const line = r.receipts.filter((x) => x.op === 'price_at');
    expect(line.map((x) => x.args.ago_s)).toEqual(lineAgo(7 * 86400));
    expect(line.every((x) => x.provenance?.series?.source === spec!.market_ids[0])).toBe(true);
    expect(d.bus.events.map((e) => e.event)).toEqual(['run.started', 'run.step', 'run.step', 'run.step']);
    const got = await getRunHandlers(d.store).getRun({ params: { run_id: rec.run_id } } as never, {} as never);
    expect(got).toMatchObject({ run_id: rec.run_id, status: 'done', last_step: 'publish' });
    // A second delivery of the same job doesn't run it again.
    const again = await handleRun(d, job, ctx());
    expect(again.run_id).toBe(rec.run_id);
    expect(again.steps).toHaveLength(3);
    expect(d.bus.events).toHaveLength(4);
  });

  it('two prices: the gap of the paired game through the engine, each price with its market and time on the receipt', async () => {
    const d = deps();
    const { byTitle } = await freshBoard();
    const w = byTitle('Gap');
    const rec = await handleRun(d, jobFor(w, 'numbers'), ctx());
    expect(rec.status).toBe('done');
    expect(rec.steps.map((s) => [s.step, s.status])).toEqual([['math', 'ok'], ['guard', 'ok'], ['publish', 'ok']]);
    const r = (await current(w)).result!;
    const ev = await via('runner', marketsApp)(MARKETS.event, { params: { event_key: 'nfl-2026w10-kc-buf' } });
    const pair = ev.pairing;
    if (!pair?.paired) throw new Error('the fixture game should pair');
    const k = ev.markets.find((m) => m.market_id === pair.kalshi)!;
    const p = ev.markets.find((m) => m.market_id === pair.polymarket)!;
    expect(r.numbers.map((n) => [n.op, n.value, n.unit])).toEqual([['gap', p.yes_price_cents - k.yes_price_cents, 'points']]);
    const receipt = r.receipts[0]!;
    expect(receipt.args).toEqual({ a_cents: k.yes_price_cents, b_cents: p.yes_price_cents });
    expect(receipt.refs).toEqual({ a_cents: 'kalshi_price', b_cents: 'polymarket_price' });
    expect(receipt.provenance).toEqual({ a_cents: { source: k.market_id, as_of: k.as_of }, b_cents: { source: p.market_id, as_of: p.as_of } });
    expect(receipt.origins).toEqual(['market']);
    expect(receipt.formula).toBe('gap = b_cents - a_cents');
    expect(r.numbers[0]!.receipt_id).toBe(receipt.id);
  });

  it('Biggest move: every game of the night through the engine, the largest move kept with its chance and line', async () => {
    const d = deps();
    const { byTitle } = await freshBoard();
    const w = byTitle('Movement');
    const rec = await handleRun(d, jobFor(w, 'numbers'), ctx());
    expect(rec.status).toBe('done');
    const r = (await current(w)).result!;
    expect(r.numbers[0]!.op).toBe('movement');
    expect(r.numbers.length).toBe(2 + LINE_POINTS);
    const spec = w.spec.kind === 'display' ? w.spec : null;
    const ids = await moverIds(via('runner', marketsApp), spec!);
    expect(ids.length).toBeGreaterThan(1);
    expect(ids).toContain(spec!.market_ids[0]);
    const moves = await Promise.all(
      ids.map(async (market_id) => {
        const h = await via('runner', marketsApp)(MARKETS.history, { params: { market_id }, query: { window_s: 86400 } });
        const last = h.points.at(-1)!;
        return { market_id, move: last.price_cents - h.points.find((p) => p.t >= last.t - 86400)!.price_cents };
      }),
    );
    const best = moves.reduce((a, b) => (Math.abs(b.move) > Math.abs(a.move) ? b : a));
    expect(r.numbers[0]!.value).toBeCloseTo(best.move, 9);
    for (const x of r.receipts) for (const p of Object.values(x.provenance ?? {})) expect(p.source).toBe(best.market_id);
    expect(new Set(r.receipts.map((x) => x.plan_hash)).size).toBe(1);
  });

  it('a movement widget the agent made for one game keeps that game: its move, volatility and small line', async () => {
    const { account_id, byTitle } = await freshBoard();
    const mover = byTitle('Movement').spec;
    if (mover.kind !== 'display') throw new Error('display');
    const own = { ...mover, title: 'Lakers at Celtics move', params: { event_keys: mover.params.event_keys } };
    expect(isBiggestMove(own)).toBe(false);
    expect(isBiggestMove(mover)).toBe(true);
    expect(defaultPlan(own).ops.map((o) => o.op)).toEqual(['movement', 'volatility', ...Array(LINE_POINTS).fill('price_at')]);
    expect(account_id).toBeTruthy();
  });

  it("Biggest move compares the widget's own games when it lists several (the user's board)", async () => {
    const { byTitle } = await freshBoard();
    const tonight = byTitle('Tonight').spec;
    const mover = byTitle('Movement').spec;
    if (tonight.kind !== 'display' || mover.kind !== 'display') throw new Error('displays');
    expect(await moverIds(via('runner', marketsApp), { ...mover, market_ids: tonight.market_ids })).toEqual(tonight.market_ids);
  });

  it("two prices: a game that isn't paired gets no number, and the widget says why in words", async () => {
    const markets = via('runner', marketsApp);
    const unpaired: Call = (async (e, input) => {
      const out = await markets(e, input as never);
      return (e as unknown) === MARKETS.event ? { ...(out as object), pairing: { paired: false, reason: 'Polymarket names the teams in another order, so its YES may mean the other team wins.' } } : out;
    }) as Call;
    const d = deps({ markets: unpaired });
    const { byTitle } = await freshBoard();
    const w = byTitle('Gap');
    const rec = await handleRun(d, jobFor(w, 'numbers'), ctx());
    expect(rec.status).toBe('done');
    const math = rec.steps.find((s) => s.step === 'math')!;
    expect(math).toMatchObject({ status: 'skipped', note: expect.stringMatching(/^Not compared: Polymarket names the teams/) });
    const r = (await current(w)).result!;
    expect(r.numbers).toEqual([]);
    expect(r.summary).toEqual({ template: math.note, slots: {} });
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
    // The balance, then each position's value, P&L and today's change: every one from the engine, with a receipt.
    expect(r.numbers.map((n) => n.id).slice(0, 4)).toEqual(['balance', 'value_1', 'pnl_1', 'today_1']);
    expect(r.numbers.find((n) => n.id === 'balance')).toMatchObject({ op: 'position_value', unit: 'dollars' });
    const rc = new Map(r.receipts.map((x) => [x.op_id, x]));
    for (const n of r.numbers) expect(rc.get(n.id)?.id).toBe(n.receipt_id);
    expect([...rc.get('balance')!.origins!]).toEqual(['connection']);
    for (const x of r.receipts.filter((x) => x.op_id !== 'balance')) expect([...x.origins!].sort()).toEqual(['connection', 'market']);
    // Provenance: the account's numbers say the exchange, read only, and connections' time.
    const bal = rc.get('balance')!;
    expect(JSON.stringify(bal)).toContain('Kalshi account, read only');
    const today = rc.get('today_1')!;
    expect(today.refs).toMatchObject({ avg_price_cents: 'prev_price_1', price_cents: 'pos_price_1' });
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

  /** The models fake, with the reader's or planner's answer replaced (what a real model wrote). */
  const answering = (role: CompleteBody['role'], content: string, seen: CompleteBody[] = []): Call => {
    const inner = models({}, seen);
    return (async (e, input) => {
      const r = (await inner(e, input as never)) as { content: string };
      return (input as { body: CompleteBody }).body.role === role ? { ...r, content } : r;
    }) as Call;
  };

  it('the page check kills the poisoned box even when the reader reports nothing, and the page never reaches the reader', async () => {
    // The A1.2.1 bake-off: the real readers left the planted orders out of their facts.
    const seen: CompleteBody[] = [];
    const d = deps({ models: answering('reader', '{"facts": [{"claim": "Buffalo\'s left tackle is questionable", "quote": "Buffalo\'s left tackle is questionable"}]}', seen), guard: layerOneGuard });
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const rec = await handleRun(d, jobFor(w, 'research'), ctx());
    expect(rec.status).toBe('poisoned');
    const poisoned = rec.steps.filter((s) => s.status === 'poisoned');
    expect(poisoned).toHaveLength(1);
    const read = rec.steps.find((s) => s.step === 'read' && s.sandbox?.sandbox_id === poisoned[0]!.sandbox!.sandbox_id)!;
    expect(read.source!.domain).toBe('fanpost.fixture.test');
    expect(await sandbox.getJob(`${rec.run_id}:read:${read.source!.candidate_id}`)).toMatchObject({ state: 'killed', kill_reason: 'poison' });
    const readerSaw = seen.filter((b) => b.role === 'reader').map((b) => b.messages.at(-1)!.content);
    expect(readerSaw.length).toBeGreaterThan(0);
    for (const t of readerSaw) expect(t).not.toMatch(/ignore your previous instructions/i);
    // The clean pages were read and released.
    const clean = rec.steps.filter((s) => s.step === 'extract' && s.status === 'ok');
    expect(clean.length).toBe(readerSaw.length);
    for (const s of clean) expect(s.sandbox!.state).toBe('released');
  });

  it("a planner plan with an arg name the engine doesn't know is refused up front for the default plan, in code", async () => {
    const bad = '{"candidate_ids": "all-allowed", "plan": {"plan_version": 1, "ops": [{"id": "n1", "op": "implied_probability", "args": {"price": "kalshi_price"}}]}}';
    const d = deps({ models: answering('planner', bad) });
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const rec = await handleRun(d, jobFor(w, 'research'), ctx());
    expect(rec.steps.find((s) => s.step === 'plan')!.note).toMatch(/^planner plan refused \(op n1 \(implied_probability\) has no arg price; it takes price_cents\): default plan;/);
    expect(rec.steps.filter((s) => s.step === 'math').map((s) => s.status)).toEqual(['ok']);
    expect((await current(w)).result!.numbers.length).toBeGreaterThan(0);
  });

  const PROB = { op: 'implied_probability', args: { price_cents: 'price_1' } };
  const MOVE = { op: 'movement', args: { series: 'series_1', window_s: 'window_s' } };
  const planOf = (...ops: (typeof PROB | typeof MOVE)[]) => ({ plan_version: 1, ops: ops.map((o, i) => ({ id: `n${i + 1}`, ...o })) });
  /** A planner answering each call with the next plan and a different clean article; `picked` records its choices. */
  const planning = (plans: object[], picked: string[][] = []): Call => {
    const inner = models();
    return (async (e, input) => {
      const r = (await inner(e, input as never)) as { content: string };
      const body = (input as { body: CompleteBody }).body;
      if (body.role !== 'planner') return r;
      const { candidates } = JSON.parse(body.messages.at(-1)!.content) as { candidates: { id: string; domain: string }[] };
      const clean = candidates.filter((c) => !c.domain.startsWith('fanpost'));
      const candidate_ids = [clean[picked.length % clean.length]!.id];
      const plan = plans[picked.length];
      picked.push(candidate_ids);
      return { ...r, content: JSON.stringify({ candidate_ids, plan }) };
    }) as Call;
  };
  const opsOf = async (w: Widget) => (await current(w)).result!.numbers.map((n) => n.op);
  const articlesOf = async (w: Widget) => (await current(w)).result!.sources.map((s) => s.candidate_id);
  const planNote = (rec: { steps: { step: string; note: string | null }[] }) => rec.steps.find((s) => s.step === 'plan')!.note;
  const tune = async (w: Widget) => {
    const p = await via('agent', boardApp)(BOARD.propose, { params: { account_id: w.spec.account_id }, body: { changes: [{ op: 'tune', widget_id: w.spec.widget_id, brief: 'only injuries' }] } });
    await edgeBoard(BOARD.accept, { params: { proposal_id: p.proposal_id }, body: { account_id: w.spec.account_id } });
  };

  it("a card's math stays put: the first model plan is saved, a refresh repeats it with the planner's new articles, a tune starts over", async () => {
    const plans = [planOf(PROB, MOVE), planOf(PROB), planOf(MOVE)];
    const picked: string[][] = [];
    const d = deps({ models: planning(plans, picked) });
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');

    const first = await handleRun(d, jobFor(w, 'research'), ctx());
    expect(first.status).toBe('done');
    expect(planNote(first)).toBe('planner plan; 1 source(s)');
    expect((await current(w)).profile!.last_math_plan).toEqual(plans[0]);
    expect(await opsOf(w)).toEqual(['implied_probability', 'movement']);
    expect(await articlesOf(w)).toEqual(picked[0]);

    const refresh = await handleRun(d, jobFor(w, 'research', 'refresh', Date.now() + 120_000), ctx());
    expect(refresh.status).toBe('done');
    expect(planNote(refresh)).toBe('saved plan; 1 source(s)');
    expect(await opsOf(w)).toEqual(['implied_probability', 'movement']);
    expect(picked[1]).not.toEqual(picked[0]);
    expect(await articlesOf(w)).toEqual(picked[1]);
    expect((await current(w)).profile!.last_math_plan).toEqual(plans[0]);

    await tune(w);
    expect((await current(w)).profile!.last_math_plan).toBeNull();
    const tuned = await handleRun(d, jobFor(w, 'research', 'refresh', Date.now() + 240_000), ctx());
    expect(planNote(tuned)).toBe('planner plan; 1 source(s)');
    expect(await opsOf(w)).toEqual(['movement']);
    expect((await current(w)).profile!.last_math_plan).toEqual(plans[2]);
  });

  it('a default plan is never saved, nor a model plan the engine had errors on', async () => {
    const { byTitle } = await freshBoard();
    const refused = byTitle('Bills news');
    await handleRun(deps({ models: planning([planOf({ op: 'gap', args: { a_cents: 'price_1', b_cents: 'price_1' } } as never)]) }), jobFor(refused, 'research'), ctx());
    expect((await current(refused)).result!.numbers.length).toBeGreaterThan(0);
    expect((await current(refused)).profile!.last_math_plan).toBeNull();

    const b = await freshBoard();
    const errored = b.byTitle('Bills news');
    const failing: SandboxClient = {
      ...sandbox,
      getJob: async (id) => {
        const j = await sandbox.getJob(id);
        return j.compute_result ? { ...j, compute_result: { ...j.compute_result, errors: [{ op_id: 'n2', code: 'bad_arg', message: 'x' }] } } : j;
      },
    };
    await handleRun(deps({ models: planning([planOf(PROB, MOVE)]), sandbox: failing }), jobFor(errored, 'research'), ctx());
    expect((await current(errored)).result!.numbers.length).toBeGreaterThan(0);
    expect((await current(errored)).profile!.last_math_plan).toBeNull();
  });

  it('a saved plan that no longer passes the check is ignored: the planner plan computes the card', async () => {
    const { byTitle, account_id } = await freshBoard();
    const w = byTitle('Bills news');
    const gap = planOf({ op: 'gap', args: { a_cents: 'price_1', b_cents: 'price_1' } } as never);
    await via('runner', boardApp)(BOARD.putResult, { params: { widget_id: w.spec.widget_id }, body: { ...sampleResult(w.spec.widget_id, account_id, 'pass'), math_plan: gap as never } });
    const rec = await handleRun(deps({ models: planning([planOf(PROB)]) }), jobFor(w, 'research'), ctx());
    expect(planNote(rec)).toBe('planner plan; 1 source(s)');
    expect(await opsOf(w)).toEqual(['implied_probability']);
    expect((await current(w)).profile!.last_math_plan).toEqual(gap);
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

  it('a publish the guard blocks whole: the guard step names the rules and where they hit (C2.1: a live run published nothing, unexplained)', async () => {
    const d = deps();
    const g = modelGuard(d.models);
    d.guard = { ...g, extract: g.extract.bind(g), publish: async (draft, account) => ({ ...(await g.publish(draft, account)), outcome: 'block' as const, reasons: [{ code: 'advice' as const, where: 'facts.f2' }] }) };
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const rec = await handleRun(d, jobFor(w, 'research'), ctx()).catch((e) => e);
    expect(String(rec)).toMatch(/guard_block/);
    const steps = [...d.store.runs.values()].flatMap((r) => r.steps).filter((s) => s.step === 'guard');
    expect(steps.at(-1)!.note).toMatch(/(^|; )blocked: advice@facts\.f2$/);
  });

  // A1.3.6: a fact that breaks a rule is left out, not the whole widget.
  /** The real guard, with reasons added at the publish stage by `flag` (what a rule or a live model said about the draft). */
  const flagging = (d: RunnerDeps, flag: (draft: Parameters<Guard['publish']>[0]) => Verdict['reasons']): Guard => {
    const g = modelGuard(d.models);
    return {
      extract: g.extract,
      publish: async (draft, account) => {
        const v = await g.publish(draft, account);
        const reasons = [...v.reasons, ...flag(draft)];
        return reasons.length ? { ...v, outcome: 'block' as const, reasons } : v;
      },
    };
  };
  /** The fake reader gives one fact a page; these tests need several. The quote is on the fixture page, so all four are kept. */
  const FOUR_FACTS = JSON.stringify({ facts: ['The left tackle has a knee injury.', 'The left tackle is listed questionable.', 'The injury is to a starter.', 'The report names a knee problem.'].map((claim) => ({ claim, quote: 'listed as questionable with a knee injury' })) });
  const guardNote = (d: { store: MemoryStore }) => [...d.store.runs.values()].flatMap((r) => r.steps).filter((s) => s.step === 'guard').at(-1)!.note;

  it('advice in one fact (layer two names its id): that fact is left out, the rest goes out with a plain note', async () => {
    const inner = answering('reader', FOUR_FACTS);
    // The decision model at the publish stage calls f2 advice while f2 is in the draft.
    const live: Call = (async (e, input) => {
      const body = (input as { body: CompleteBody }).body;
      const r = (await inner(e, input as never)) as { content: string };
      if (body.role !== 'guard' || !body.messages[0]!.content.includes('{"advice": [ids]}')) return r;
      const items = (JSON.parse(body.messages[1]!.content) as { items: { id: string }[] }).items;
      return { ...r, content: JSON.stringify({ advice: items.some((i) => i.id === 'f2') ? ['f2'] : [] }) };
    }) as Call;
    const d = deps({ models: live });
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const rec = await handleRun(d, jobFor(w, 'research'), ctx());
    expect(rec.status).toBe('poisoned'); // this widget's fixture pages include the poisoned one: its box is killed as before
    const r = (await current(w)).result!;
    expect(r.facts.length).toBeGreaterThan(0);
    expect(r.facts.map((f) => f.fact_id)).not.toContain('f2');
    expect(r.blocked.length).toBeGreaterThan(0);
    expect(r.facts.some((f) => r.blocked.some((b) => b.candidate_id === f.candidate_id))).toBe(false);
    expect(r.notes).toContain('One item was left out because it read like advice.');
    expect(r.summary).not.toBeNull(); // the fake summary quotes {q1}, not f2
    expect(guardNote(d)).toBe('facts left out: advice@f2');
    expect(rec.steps.find((s) => s.step === 'guard')!.status).toBe('ok');
  });

  it('a layer-one rule on facts (unsourced_claim at fact ids): one sentence per rule, and the rest goes out', async () => {
    const d = deps({ models: answering('reader', FOUR_FACTS) });
    d.guard = flagging(d, (draft) => [
      ...draft.facts.filter((f) => f.fact_id === 'f2' || f.fact_id === 'f3').map((f) => ({ code: 'unsourced_claim' as const, where: f.fact_id })),
      ...draft.facts.filter((f) => f.fact_id === 'f4').map((f) => ({ code: 'advice' as const, where: f.fact_id })),
    ]);
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    await handleRun(d, jobFor(w, 'research'), ctx());
    const r = (await current(w)).result!;
    const left = r.facts.map((f) => f.fact_id);
    expect(left).toContain('f1');
    expect(left.filter((id) => ['f2', 'f3', 'f4'].includes(id))).toEqual([]);
    expect(r.notes).toEqual(expect.arrayContaining(['Two items were left out because they had no source.', 'One item was left out because it read like advice.']));
    for (const n of r.notes ?? []) expect(n).not.toMatch(/[0-9]/);
    expect(guardNote(d)).toMatch(/^facts left out: unsourced_claim@f2, unsourced_claim@f3, advice@f4$/);
  });

  it('a summary that quotes a left-out fact loses the summary; the numbers and the other facts go out', async () => {
    const d = deps({ models: answering('reader', FOUR_FACTS) });
    d.guard = flagging(d, (draft) => draft.facts.filter((f) => f.fact_id === 'f1').map((f) => ({ code: 'advice' as const, where: f.fact_id })));
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    await handleRun(d, jobFor(w, 'research'), ctx());
    const r = (await current(w)).result!;
    expect(r.summary).toBeNull(); // the fake summary's {q1} is f1
    expect(r.facts.length).toBeGreaterThan(0);
    expect(r.facts.map((f) => f.fact_id)).not.toContain('f1');
    expect(r.numbers.length).toBeGreaterThan(0);
    expect(r.notes).toContain('One item was left out because it read like advice.');
    expect(guardNote(d)).toBe('facts left out: advice@f1; summary dropped: it quotes a fact left out');
  });

  it('every fact flagged: the whole publish is blocked, as before', async () => {
    const d = deps({ models: answering('reader', FOUR_FACTS) });
    d.guard = flagging(d, (draft) => draft.facts.map((f) => ({ code: 'advice' as const, where: f.fact_id })));
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const rec = await handleRun(d, jobFor(w, 'research'), ctx()).catch((e) => e);
    expect(String(rec)).toMatch(/guard_block/);
    expect(guardNote(d)).toMatch(/blocked: advice@f1, advice@f2/);
    expect((await current(w)).result?.facts ?? []).toEqual([]);
  });

  it.each([
    ['a number', 'missing_receipt' as const, 'n1'],
    ['a source', 'bad_link' as const, 'cand'],
    ['the guard itself', 'unchecked' as const, 'guard.model'],
  ])('a reason on %s beside a flagged fact: the whole publish is blocked, as before', async (_what, code, where) => {
    const d = deps({ models: answering('reader', FOUR_FACTS) });
    d.guard = flagging(d, (draft) => [
      ...draft.facts.filter((f) => f.fact_id === 'f2').map((f) => ({ code: 'advice' as const, where: f.fact_id })),
      { code, where: where === 'cand' ? draft.sources[0]!.candidate_id : where },
    ]);
    const { byTitle } = await freshBoard();
    const w = byTitle('Bills news');
    const rec = await handleRun(d, jobFor(w, 'research'), ctx()).catch((e) => e);
    expect(String(rec)).toMatch(/guard_block/);
    expect(guardNote(d)).toMatch(/(^|; )blocked: .*advice@f2/);
    expect(guardNote(d)).not.toMatch(/facts left out/);
    expect((await current(w)).result?.facts ?? []).toEqual([]);
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
      spec: { widget_id: 'wid_sched0000001', account_id: 'acc_sched0000001', kind: 'display', place: { col: 0, row: 0 } },
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

  it('an idle board stops: numbers after 3 hours without a visit, research after a day (runload.test.ts has the rest)', async () => {
    let t = Date.UTC(2026, 10, 7, 15, 0, 0);
    const store = new MemoryStore();
    const s = new Scheduler(store, async () => undefined, () => t);
    await s.noteRun(widget(300, 3600), { kind: 'research', reason: 'accept' });
    t += 2 * 3600_000;
    expect((await s.tick()).map((j) => j.kind).sort()).toEqual(['numbers', 'research']);
    t += 2 * 3600_000;
    expect((await s.tick()).map((j) => j.kind)).toEqual(['research']);
    t += ACTIVE_FOR_MS;
    expect(await s.tick()).toEqual([]);
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
