/**
 * Milestone N1.2's end-to-end check: "since you last looked" has its numbers. The owner opens the board, a fixture
 * price moves while they are away, they open it again: the strip shows the move, computed by the engine (a gap op in
 * the run's own compute box) with its receipt (both prices, both times, the market), and a second device with no
 * state of its own shows the same. markets runs in real mode on the recording (fixtures/markets/live/weekend), board
 * is the fake, the engine runs in the real sandbox-manager binary on its stub backend (make check builds it first).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD, MARKETS, MODELS, widgetRunJobId, type Market, type Widget } from '@app/contracts';
import { MemoryBus, createClient, createLogger, hashToken, sandboxClient, type Call, type SandboxClient } from '@app/service-kit';
import { fakeApp, TEST_TOKENS } from '@app/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sinceWords } from '../../../web/src/moment-state.ts';
import { createFakeAudit } from '../../audit/src/fake.ts';
import { fake as boardFake } from '../../board/src/fake.ts';
import { fake as modelsFake } from '../../models/src/fake.ts';
import { WEEKEND_HISTORY, realApp, weekendFetch } from '../../markets/test/recorded.ts';
import { handleRun, type RunnerDeps } from '../src/run.ts';
import { MemoryStore } from '../src/store.ts';

const MANAGER = join(import.meta.dirname, '../../../target/debug/sandbox-manager');
const PORT = 20000 + (process.pid % 300);
const have = existsSync(MANAGER);
const AT = Date.parse(WEEKEND_HISTORY.recorded_at);
const HOUR = 3600_000;

const marketsApp = realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search', HISTORY_PER_MIN: 6000, RESOLVED_PER_MIN: 6000, RESOLVED_WAIT_S: 30 }, { fetch: weekendFetch().fetch, now: () => AT, log: createLogger('markets', 'silent') });
const via = (caller: keyof typeof TEST_TOKENS, app: { fetch: (r: Request) => Response | Promise<Response> }) =>
  createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });
const boardApp = fakeApp('board', BOARD, boardFake({ markets: via('board', marketsApp), enqueue: () => undefined }));
/** Two devices: each a browser session of the same owner, with nothing of its own but what edge hands it. */
const deviceA = via('edge', boardApp);
const deviceB = via('edge', boardApp);

/** The fixture price that moves: markets answers this market `moved` cents higher, quoted at the time it moved. */
const moved = new Map<string, { cents: number; as_of: string }>();
const recorded = via('runner', marketsApp);
const runnerMarkets: Call = (async (e, input) => {
  const out = (await recorded(e, input as never)) as unknown;
  if ((e as unknown) !== MARKETS.get) return out;
  const m = out as Market;
  const mv = moved.get(m.market_id);
  return mv ? { ...m, yes_price_cents: m.yes_price_cents + mv.cents, as_of: mv.as_of } : m;
}) as Call;

let manager: ChildProcess | undefined;
let sandbox: SandboxClient;
const audit = createFakeAudit();
const deps = (): RunnerDeps =>
  ({
    board: via('runner', boardApp),
    markets: runnerMarkets,
    models: via('runner', fakeApp('models', MODELS, modelsFake())),
    sandbox,
    bus: new MemoryBus(),
    audit: async (e: never) => audit.append(e).row_id,
    store: new MemoryStore(),
    sourceEnv: 'fixture',
    pageText: () => null,
    pollMs: 10,
  }) as unknown as RunnerDeps;

async function numbersRun(w: Widget, account_id: string) {
  const window_start = Math.floor(Date.now() / 1000);
  const job = { job_id: widgetRunJobId(w.spec.widget_id, 'numbers', window_start), widget_id: w.spec.widget_id, account_id, kind: 'numbers' as const, window_start, reason: 'schedule' as const };
  const rec = await handleRun(deps(), job, { jobId: job.job_id, attempt: 1, signal: new AbortController().signal });
  expect(rec.status).toBe('done');
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AT);
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
  vi.useRealTimers();
});

describe.skipIf(!have)('Milestone N1.2: "since you last looked" has its numbers', () => {
  it('open the board, a fixture price moves, open it again: the change is there, computed by the engine and sourced, on a second device too', async () => {
    const account_id = 'acc_milestone0n12';
    const b = await deviceA(BOARD.createDefaults, { params: { account_id }, body: { category: 'sports' } });
    const market = b.widgets.find((w) => w.spec.kind === 'display' && w.spec.type === 'probability')!;
    const market_id = market.spec.kind === 'display' ? market.spec.market_ids[0]! : '';
    const mine = (x: { widgets: Widget[] }) => x.widgets.find((w) => w.spec.widget_id === market.spec.widget_id)!;

    // Visit 1: the owner opens the board, the first numbers land, the owner sees them.
    await deviceA(BOARD.getBoard, { params: { account_id } });
    await numbersRun(market, account_id);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const seen = mine(await deviceA(BOARD.getBoard, { params: { account_id } }));
    expect(seen.since ?? null).toBeNull();
    const was = seen.result!.receipts.find((r) => r.op === 'implied_probability' && r.provenance?.price_cents?.source === market_id)!;
    const wasCents = was.args.price_cents as number;

    // The owner goes away; the price moves 4 points; the scheduled run measures the move from what the owner saw.
    vi.setSystemTime(Date.now() + 2 * HOUR);
    const movedAt = new Date().toISOString();
    moved.set(market_id, { cents: 4, as_of: movedAt });
    await numbersRun(market, account_id);

    // Visit 2, on another device: the strip's move is the engine's, with its receipt.
    const onB = mine(await deviceB(BOARD.getBoard, { params: { account_id } }));
    const s = onB.since!;
    expect(s).toBeTruthy();
    expect(s.from_result_id).toBe(seen.result!.result_id);
    expect(s.from_at).toBe(seen.result!.created_at);
    const n = s.numbers[0]!;
    expect(n).toMatchObject({ op: 'gap', unit: 'points', value: 4 });
    const receipt = s.receipts.find((r) => r.id === n.receipt_id)!;
    expect(receipt).toMatchObject({ op: 'gap', value: 4, formula: expect.stringContaining('b_cents - a_cents'), args: { a_cents: wasCents, b_cents: wasCents + 4 } });
    expect(receipt.origins).toEqual(['market']);
    // Sourced: both prices name the market and when each was quoted.
    expect(receipt.provenance).toEqual({ a_cents: was.provenance!.price_cents, b_cents: { source: market_id, as_of: movedAt } });
    expect(receipt.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.plan_hash).toBe(onB.result!.receipts[0]!.plan_hash); // the same plan, the same compute box as the widget's numbers
    // "How we got this" opens it from board, and the widget's own numbers are as before (no gap among them).
    expect(await deviceB(BOARD.getReceipt, { params: { receipt_id: receipt.id }, query: { account_id } })).toEqual(receipt);
    expect(onB.result!.numbers.map((x) => x.op)).toEqual(seen.result!.numbers.map((x) => x.op));
    expect(onB.result!.numbers.find((x) => x.op === 'implied_probability')!.value).toBeCloseTo((wasCents + 4) / 100, 9);
    // The web's strip, from what edge hands over (no state on the device).
    expect(sinceWords(onB.since)).toBe('Since you last looked: up 4 points');

    // Back on the first device in the same visit: the same strip.
    vi.setSystemTime(Date.now() + 3 * 60_000);
    const onA = mine(await deviceA(BOARD.getBoard, { params: { account_id } }));
    expect(onA.since).toEqual(onB.since);
    expect(sinceWords(onA.since)).toBe('Since you last looked: up 4 points');
  }, 60_000);
});
