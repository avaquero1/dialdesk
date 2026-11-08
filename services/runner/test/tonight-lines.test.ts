/**
 * Tonight's small lines (W1.2.7): each of Tonight's games gets the Market's 7-day line, price_at at the same points
 * (lineAgo of 7 days, oldest first), in Tonight's own code plan (tonightPlan). A new board on this weekend's games (markets in real mode on
 * the recording, fixtures/markets/live/weekend; board's weekBoard picks the games), every top-level display in one
 * batch (batch.ts merge, as one compute box per board per tick runs it) through the real engine (target/debug/engine,
 * which make check builds first), sliced back per widget. And a real run (handleRun, the sandbox-manager binary on its
 * stub backend) publishes those lines.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD, EngineResult, MARKETS, MODELS, widgetRunJobId, type EngineInput, type EnginePlan, type WidgetSpec } from '@app/contracts';
import { MemoryBus, createClient, createLogger, hashToken, sandboxClient, type SandboxClient } from '@app/service-kit';
import { TEST_TOKENS, fakeApp } from '@app/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeAudit } from '../../audit/src/fake.ts';
import { fake as boardFake } from '../../board/src/fake.ts';
import { weekBoard } from '../../board/src/defaults.ts';
import { fake as modelsFake } from '../../models/src/fake.ts';
import { WEEKEND_HISTORY, realApp, weekendFetch } from '../../markets/test/recorded.ts';
import { merge, slice } from '../src/batch.ts';
import { LINE_POINTS, MAX_TONIGHT, biggestMoveNumbers, defaultPlan, isBiggestMove, lineAgo, marketNumbers, planProblem, runnablePlan, tonightPlan, type MarketNumbers } from '../src/plans.ts';
import { handleRun, type RunnerDeps } from '../src/run.ts';
import { MemoryStore } from '../src/store.ts';

type DisplaySpec = Extract<WidgetSpec, { kind: 'display' }>;
const ENGINE = join(import.meta.dirname, '../../../target/debug/engine');
const MANAGER = join(import.meta.dirname, '../../../target/debug/sandbox-manager');
const PORT = 20100 + (process.pid % 300);
/** The engine's own cap on one input's ops (engine/src/lib.rs MAX_OPS): one box per board must stay under it. */
const ENGINE_MAX_OPS = 256;
const DAY = 86400;
const AT = Date.parse(WEEKEND_HISTORY.recorded_at);
const app = realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search', HISTORY_PER_MIN: 6000, RESOLVED_PER_MIN: 6000, RESOLVED_WAIT_S: 30 }, { fetch: weekendFetch().fetch, now: () => AT, log: createLogger('markets', 'silent') });
const markets = createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS.runner, fetch: (r) => app.fetch(r) });

function engine(input: EngineInput): EngineResult {
  const r = spawnSync(ENGINE, [], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 << 20 });
  expect(r.status, r.stderr).toBe(0);
  return EngineResult.parse(JSON.parse(r.stdout));
}

/** This weekend's first board, its top-level displays as specs (folder cards run at the slow speed, in their own tick). */
async function firstBoard(): Promise<DisplaySpec[]> {
  const list = await markets(MARKETS.list, { query: { category: 'sports' } });
  const tiles = weekBoard(list.markets, AT);
  expect(tiles).not.toBeNull();
  return tiles!.flatMap((t, i) =>
    t.kind === 'display'
      ? [{ ...t, kind: 'display', widget_id: `wdg_tonight${String(i).padStart(5, '0')}`, account_id: 'acc_tonight00001', sources: [] } as unknown as DisplaySpec]
      : [],
  );
}

async function inputFor(spec: DisplaySpec): Promise<{ input: EngineInput; mn: MarketNumbers } | null> {
  let plan: EnginePlan = defaultPlan(spec);
  let mn: MarketNumbers;
  if (isBiggestMove(spec)) ({ plan, mn } = await biggestMoveNumbers(markets, spec));
  else if (spec.type === 'gap' || spec.type === 'positions') return null;
  else if (spec.type === 'events') {
    plan = tonightPlan(spec);
    mn = await marketNumbers(markets, spec, plan);
  }
  else mn = await marketNumbers(markets, spec, plan);
  const p = runnablePlan(plan, mn.numbers);
  return p.ops.length ? { input: { plan: p, numbers: mn.numbers, origins: mn.origins, ...(mn.provenance ? { provenance: mn.provenance } : {}) }, mn } : null;
}

describe('Tonight’s plan (W1.2.7)', () => {
  it('each game: its chance, its move over window_s and the Market’s line points, oldest first', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `kalshi:KXNBAGAME-26NOV08G${i}-G${i}`);
    const plan = tonightPlan({ kind: 'display', type: 'events', title: 'Tonight', size: 'L', market_ids: ids, params: { window_s: DAY }, sources: [] } as unknown as DisplaySpec);
    expect(plan.ops.length).toBe(MAX_TONIGHT * (2 + LINE_POINTS));
    for (let i = 1; i <= MAX_TONIGHT; i++) {
      const mine = plan.ops.filter((o) => Object.values(o.args).some((a) => a === `price_${i}` || a === `series_${i}`));
      expect(mine.map((o) => o.op)).toEqual(['implied_probability', 'movement', ...Array(LINE_POINTS).fill('price_at')]);
      expect(mine.filter((o) => o.op === 'price_at').map((o) => o.args.ago_s)).toEqual(Array.from({ length: LINE_POINTS }, (_, j) => `ago_${j + 1}`));
    }
    // The chances and moves first (their ids as before the lines), then the lines.
    expect(plan.ops.slice(0, 2 * MAX_TONIGHT).every((o) => o.op !== 'price_at')).toBe(true);
  });

  it('the lines are in the code plan only: a default plan stays what a planner could write', () => {
    const s = { kind: 'display', type: 'events', title: 'Tonight', size: 'L', market_ids: ['kalshi:KXNBAGAME-26NOV08LALBOS-LAL', 'kalshi:KXNBAGAME-26NOV08NYKMIA-NYK'], params: { window_s: DAY }, sources: [] } as unknown as DisplaySpec;
    const plan = defaultPlan(s);
    expect(plan.ops.map((o) => o.op)).toEqual(['implied_probability', 'movement', 'implied_probability', 'movement']);
    expect(planProblem(s, plan)).toBeNull();
    expect(tonightPlan(s).ops.slice(0, plan.ops.length)).toEqual(plan.ops);
  });

  it('never the same plan as Biggest move’s for as many games (a receipt id is the plan’s hash and the op id)', () => {
    const ids = ['kalshi:KXNBAGAME-26NOV08LALBOS-LAL', 'kalshi:KXNBAGAME-26NOV08NYKMIA-NYK'];
    const tonight = tonightPlan({ kind: 'display', type: 'events', title: 'Tonight', size: 'L', market_ids: ids, params: { window_s: DAY }, sources: [] } as unknown as DisplaySpec);
    // Biggest move's plan (biggestMoveNumbers): per game, its chance, move and line together.
    const biggest = ids.flatMap((_, i) => [
      { op: 'implied_probability', args: { price_cents: `price_${i + 1}` } },
      { op: 'movement', args: { series: `series_${i + 1}`, window_s: 'window_s' } },
      ...Array.from({ length: LINE_POINTS }, (_, j) => ({ op: 'price_at', args: { series: `series_${i + 1}`, ago_s: `ago_${j + 1}` } })),
    ]);
    expect(tonight.ops.map(({ op, args }) => ({ op, args }))).not.toEqual(biggest);
    expect(tonight.ops.length).toBe(biggest.length);
  });
});

describe.skipIf(!existsSync(ENGINE))('Tonight’s small lines come from the engine, in the board’s one box (this weekend’s games)', () => {
  it('every Tonight game has a 7-day line of price_at numbers from its own market, and the board’s batch fits one box', async () => {
    const specs = await firstBoard();
    const tonight = specs.find((s) => s.type === 'events')!;
    expect(tonight.market_ids.length).toBeGreaterThan(1);
    const parts: { spec: DisplaySpec; input: EngineInput; prefix: string }[] = [];
    let tonightMn: MarketNumbers | undefined;
    for (const [i, spec] of specs.entries()) {
      const x = await inputFor(spec);
      if (!x) continue;
      parts.push({ spec, input: x.input, prefix: `b${i}_` });
      if (spec === tonight) tonightMn = x.mn;
    }
    const merged = merge(parts.map(({ input, prefix }) => ({ input, prefix })));
    // Still one compute box per board per tick: the whole board's plan is one engine input under the engine's cap.
    expect(merged.plan.ops.length).toBeLessThanOrEqual(ENGINE_MAX_OPS);
    const er = engine(merged);
    expect(er.errors.filter((e) => e.op_id === 'plan')).toEqual([]);
    const mine = slice(er, parts.find((p) => p.spec === tonight)!.prefix);
    expect(mine.errors).toEqual([]);

    const want = lineAgo(7 * DAY);
    const games = tonight.market_ids.slice(0, MAX_TONIGHT);
    for (const [i, market_id] of games.entries()) {
      const pts = mine.numbers
        .filter((n) => n.op === 'price_at')
        .map((n) => ({ n, r: mine.receipts.find((r) => r.id === n.receipt_id)! }))
        .filter(({ r }) => Object.values(r.provenance ?? {}).some((p) => p.source === market_id));
      expect(pts.length, market_id).toBe(LINE_POINTS);
      // The Market's 7 days, at the Market's points, oldest first (as the web draws it).
      expect(pts.map(({ r }) => r.args.ago_s)).toEqual(want);
      expect(pts.every(({ n }) => n.unit === 'cents' && n.value >= 0 && n.value <= 100)).toBe(true);
      // Each point is the engine's read of the game's own history: the first price at or after that time.
      const s = tonightMn!.numbers[`series_${i + 1}`] as { t: number; v: number }[];
      const last = s[s.length - 1]!;
      const byHand = want.map((ago) => (ago === 0 ? last.v : (s.find((p) => p.t >= last.t - ago) ?? last).v));
      expect(pts.map(({ n }) => n.value)).toEqual(byHand);
      // The move is still the game's window_s move, beside its line.
      const mv = mine.numbers.find((n) => n.op === 'movement' && Object.values(mine.receipts.find((r) => r.id === n.receipt_id)!.provenance ?? {}).some((p) => p.source === market_id));
      expect(mine.receipts.find((r) => r.id === mv!.receipt_id)!.args.window_s).toBe(DAY);
    }
    // The line reaches 7 days back: markets was asked for (at least) 7 days of history.
    expect(Math.max(...want)).toBe(7 * DAY);
  }, 60_000);
});

describe.skipIf(!existsSync(MANAGER))('a real numbers run publishes Tonight’s lines (stub sandbox-manager)', () => {
  let manager: ChildProcess | undefined;
  let sandbox: SandboxClient;
  const via = (caller: keyof typeof TEST_TOKENS, a: { fetch: (r: Request) => Response | Promise<Response> }) =>
    createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => a.fetch(r) });
  const boardApp = fakeApp('board', BOARD, boardFake({ markets: via('board', app), enqueue: () => undefined }));
  const audit = createFakeAudit();

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT);
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
    vi.useRealTimers();
  });

  it('runner runs tonightPlan for Tonight: every game’s result holds its 8 line points', async () => {
    const account_id = 'acc_tonightrun001';
    const edge = via('edge', boardApp);
    const b = await edge(BOARD.createDefaults, { params: { account_id }, body: { category: 'sports' } });
    const w = b.widgets.find((x) => x.spec.kind === 'display' && x.spec.type === 'events')!;
    if (w.spec.kind !== 'display') throw new Error('Tonight is a display');
    const games = w.spec.market_ids.slice(0, MAX_TONIGHT);
    const d = {
      board: via('runner', boardApp),
      markets,
      models: via('runner', fakeApp('models', MODELS, modelsFake())),
      sandbox,
      bus: new MemoryBus(),
      audit: async (e: never) => audit.append(e).row_id,
      store: new MemoryStore(),
      sourceEnv: 'fixture',
      pageText: () => null,
      pollMs: 10,
    } as unknown as RunnerDeps;
    const window_start = Math.floor(AT / 1000);
    const job = { job_id: widgetRunJobId(w.spec.widget_id, 'numbers', window_start), widget_id: w.spec.widget_id, account_id, kind: 'numbers' as const, window_start, reason: 'accept' as const };
    const rec = await handleRun(d, job, { jobId: job.job_id, attempt: 1, signal: new AbortController().signal });
    expect(rec.status).toBe('done');
    const r = (await edge(BOARD.getWidget, { params: { widget_id: w.spec.widget_id }, query: { account_id } })).result!;
    const line = r.numbers.filter((n) => n.op === 'price_at');
    expect(line.length).toBe(games.length * LINE_POINTS);
    for (const market_id of games) {
      const mine = line.map((n) => r.receipts.find((x) => x.id === n.receipt_id)!).filter((x) => Object.values(x.provenance ?? {}).some((p) => p.source === market_id));
      expect(mine.map((x) => x.args.ago_s), market_id).toEqual(lineAgo(7 * DAY));
    }
  }, 60_000);
});
