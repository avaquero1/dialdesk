/**
 * Milestone N1.1's end-to-end check: a new board on this weekend's games (markets in real mode on the recording,
 * fixtures/markets/live/weekend) shows Tonight, a market, Two prices and Biggest move with engine numbers, and every
 * number's "How we got this" opens its receipt (board's getReceipt, as edge asks for it). The engine runs in the real
 * sandbox-manager binary on its stub backend. Needs target/debug/sandbox-manager (make check builds it first).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD, MARKETS, MODELS, widgetRunJobId, type EngineReceipt, type Widget } from '@app/contracts';
import { MemoryBus, createClient, createLogger, hashToken, sandboxClient, type SandboxClient } from '@app/service-kit';
import { fakeApp, TEST_TOKENS } from '@app/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeAudit } from '../../audit/src/fake.ts';
import { fake as boardFake } from '../../board/src/fake.ts';
import { fake as modelsFake } from '../../models/src/fake.ts';
import { WEEKEND_HISTORY, realApp, weekendFetch } from '../../markets/test/recorded.ts';
import { LINE_POINTS, MAX_MOVERS, lineAgo } from '../src/plans.ts';
import { handleRun, type RunnerDeps } from '../src/run.ts';
import { MemoryStore } from '../src/store.ts';

const MANAGER = join(import.meta.dirname, '../../../target/debug/sandbox-manager');
const PORT = 19700 + (process.pid % 300);
const have = existsSync(MANAGER);
const AT = Date.parse(WEEKEND_HISTORY.recorded_at);
const DAY = 86400;

const marketsApp = realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search', HISTORY_PER_MIN: 6000 }, { fetch: weekendFetch().fetch, now: () => AT, log: createLogger('markets', 'silent') });
const via = (caller: keyof typeof TEST_TOKENS, app: { fetch: (r: Request) => Response | Promise<Response> }) =>
  createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });
const boardApp = fakeApp('board', BOARD, boardFake({ markets: via('board', marketsApp), enqueue: () => undefined }));
const edge = via('edge', boardApp);
const runnerMarkets = via('runner', marketsApp);
const audit = createFakeAudit();

let manager: ChildProcess | undefined;
let sandbox: SandboxClient;

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

/** The move the engine should find, computed here by hand from markets' own history: last minus the point a window back. */
async function moveOf(market_id: string, window_s: number) {
  const h = await runnerMarkets(MARKETS.history, { params: { market_id }, query: { window_s } });
  const last = h.points.at(-1)!;
  const start = h.points.find((p) => p.t >= last.t - window_s)!;
  return { market_id, move: last.price_cents - start.price_cents, last: last.price_cents, as_of: h.as_of };
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

describe.skipIf(!have)('Milestone N1.1: a new board’s numbers come from the engine, each with its receipt (this weekend’s games)', () => {
  it('Tonight, a market, Two prices and Biggest move: engine numbers, and every number’s receipt opens', async () => {
    const account_id = 'acc_milestone0n11';
    const b = await edge(BOARD.createDefaults, { params: { account_id }, body: { category: 'sports' } });
    const of = (type: string) => b.widgets.find((w) => w.spec.kind === 'display' && w.spec.type === type)!;
    const widgets = { tonight: of('events'), market: of('probability'), gap: of('gap'), biggest: of('movement') };
    const recorded = new Set(WEEKEND_HISTORY.files.map((f) => f.market_id));
    for (const w of Object.values(widgets)) for (const id of w.spec.kind === 'display' ? w.spec.market_ids : []) expect(recorded.has(id), id).toBe(true);

    const d = deps();
    const results = new Map<string, NonNullable<Widget['result']>>();
    for (const [name, w] of Object.entries(widgets)) {
      const window_start = Math.floor(AT / 1000);
      const job = { job_id: widgetRunJobId(w.spec.widget_id, 'numbers', window_start), widget_id: w.spec.widget_id, account_id, kind: 'numbers' as const, window_start, reason: 'accept' as const };
      const rec = await handleRun(d, job, { jobId: job.job_id, attempt: 1, signal: new AbortController().signal });
      expect(rec.status, name).toBe('done');
      expect(rec.steps.map((s) => [s.step, s.status]), name).toEqual([['math', 'ok'], ['guard', 'ok'], ['publish', 'ok']]);
      const cur = await edge(BOARD.getWidget, { params: { widget_id: w.spec.widget_id }, query: { account_id } });
      const r = cur.result!;
      expect(r.numbers.length, name).toBeGreaterThan(0);
      // Every number has its receipt on the result, and "How we got this" opens the same receipt from board.
      for (const n of r.numbers) {
        const receipt = r.receipts.find((x) => x.id === n.receipt_id)!;
        expect(receipt, `${name} ${n.id}`).toBeDefined();
        expect(receipt).toMatchObject({ op: n.op, value: n.value, unit: n.unit });
        expect(receipt.plan_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(receipt.input_hash).toMatch(/^[0-9a-f]{64}$/);
        const opened = await edge(BOARD.getReceipt, { params: { receipt_id: n.receipt_id }, query: { account_id } });
        expect(opened).toEqual(receipt);
        // Every price and series the number read says which market it came from and when.
        for (const [arg, ref] of Object.entries(receipt.refs ?? {})) {
          if (!/(price|series)/.test(ref)) continue;
          expect(receipt.provenance?.[arg], `${name} ${n.id} ${arg}`).toMatchObject({ source: expect.stringMatching(/^(kalshi|polymarket):/), as_of: expect.any(String) });
          expect(recorded.has(receipt.provenance![arg]!.source)).toBe(true);
        }
      }
      results.set(name, r);
    }

    // Tonight: each game's chance and its move since yesterday.
    const tonight = results.get('tonight')!;
    const games = widgets.tonight.spec.kind === 'display' ? widgets.tonight.spec.market_ids : [];
    expect(tonight.numbers.filter((n) => n.op === 'movement').length).toBe(Math.min(games.length, 6));
    for (const n of tonight.numbers.filter((x) => x.op === 'movement')) {
      const rc = tonight.receipts.find((x) => x.id === n.receipt_id)!;
      const want = await moveOf(rc.provenance!.series!.source, DAY);
      expect(n.value).toBeCloseTo(want.move, 9);
    }

    // A market: its chance, up or down since yesterday, and the 7-day line (oldest first, ending at the last price).
    const market = results.get('market')!;
    const mId = widgets.market.spec.kind === 'display' ? widgets.market.spec.market_ids[0]! : '';
    const since = market.numbers.find((n) => n.op === 'movement')!;
    expect(market.receipts.find((x) => x.id === since.receipt_id)!.args.window_s).toBe(DAY);
    expect(since.value).toBeCloseTo((await moveOf(mId, DAY)).move, 9);
    const line = market.numbers.filter((n) => n.op === 'price_at');
    expect(line.length).toBe(LINE_POINTS);
    expect(line.map((n) => market.receipts.find((x) => x.id === n.receipt_id)!.args.ago_s)).toEqual(lineAgo(7 * DAY));
    expect(line.at(-1)!.value).toBe((await moveOf(mId, 7 * DAY)).last);

    // Two prices: the gap, both prices from the paired game.
    const gap = results.get('gap')!;
    expect(gap.numbers.map((n) => n.op)).toEqual(['gap']);
    expect(Object.keys(gap.receipts[0]!.provenance ?? {}).sort()).toEqual(['a_cents', 'b_cents']);

    // Biggest move: the largest move since yesterday among tonight's games, with its chance and a small line.
    const biggest = results.get('biggest')!;
    expect(biggest.numbers[0]!.op).toBe('movement');
    expect(biggest.numbers.map((n) => n.op).sort()).toEqual(['implied_probability', 'movement', ...Array(LINE_POINTS).fill('price_at')].sort());
    const moveReceipt = biggest.receipts.find((x) => x.id === biggest.numbers[0]!.receipt_id) as EngineReceipt;
    const winner = moveReceipt.provenance!.series!.source;
    for (const r of biggest.receipts) for (const p of Object.values(r.provenance ?? {})) expect(p.source).toBe(winner);
    const list = await runnerMarkets(MARKETS.list, { query: { category: 'sports' } });
    const day = (widgets.biggest.spec.kind === 'display' && widgets.biggest.spec.params.event_keys?.[0]?.split('-').slice(1, 4).join('-')) || '';
    const candidates = list.markets
      .filter((m) => m.exchange === 'kalshi' && m.event_key?.includes(`-${day}-`) && m.market_id.endsWith(`-${m.event_key.split('-')[4]!.toUpperCase()}`))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, MAX_MOVERS);
    expect(candidates.length).toBeGreaterThan(1);
    const moves = await Promise.all(candidates.map((m) => moveOf(m.market_id, DAY)));
    const largest = Math.max(...moves.map((m) => Math.abs(m.move)));
    expect(Math.abs(biggest.numbers[0]!.value)).toBeCloseTo(largest, 9);
    expect(moves.find((m) => m.market_id === winner)!.move).toBeCloseTo(biggest.numbers[0]!.value, 9);
  }, 60_000);
});
