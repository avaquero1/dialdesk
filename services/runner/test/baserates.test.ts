/**
 * Base rates (N1.1.4): a Market's two base rates from this season's settled games, markets in real mode on the
 * recording (fixtures/markets/live/weekend/resolved), through runner's planner and the engine (target/debug/engine,
 * which make check builds first). Too few games: words, no number.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EngineResult, MARKETS, type DisplayType, type ResolvedHistory, type WidgetSpec } from '@app/contracts';
import { CallError, createClient, createLogger, type Call } from '@app/service-kit';
import { TEST_TOKENS } from '@app/testkit';
import { describe, expect, it } from 'vitest';
import { WEEKEND_RESOLVED, realApp, weekendFetch } from '../../markets/test/recorded.ts';
import { BAND_CENTS, MIN_BASE_RATE_N, defaultPlan, marketNumbers, numberKeys, planProblem, runnablePlan } from '../src/plans.ts';

const ENGINE = join(import.meta.dirname, '../../../target/debug/engine');
const AT = Date.parse(WEEKEND_RESOLVED.recorded_at);
const app = realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search', HISTORY_PER_MIN: 6000, RESOLVED_PER_MIN: 6000, RESOLVED_WAIT_S: 30 }, { fetch: weekendFetch().fetch, now: () => AT, log: createLogger('markets', 'silent') });
const markets = createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS.runner, fetch: (r) => app.fetch(r) });

const spec = (market_id: string, type: DisplayType = 'probability') =>
  ({ kind: 'display', widget_id: 'wdg_baserate0001', account_id: 'acc_baserate0001', type, title: 'Market', size: 'M', market_ids: [market_id], params: {}, sources: [] }) as unknown as Extract<WidgetSpec, { kind: 'display' }>;

function engine(input: unknown): EngineResult {
  const r = spawnSync(ENGINE, [], { input: JSON.stringify(input), encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return EngineResult.parse(JSON.parse(r.stdout));
}

/**
 * A league's first game this weekend on Kalshi (the away team's market, as boards pick it), priced in lo..hi: a game
 * already decided (99¢) has too few teams priced near it.
 */
async function weekendGame(league: 'nfl' | 'nba', lo = 25, hi = 75) {
  const list = await markets(MARKETS.list, { query: { league } });
  return list.markets.find(
    (m) => m.exchange === 'kalshi' && m.event_key && m.market_id.endsWith(`-${m.event_key.split('-')[4]!.toUpperCase()}`) && m.yes_price_cents >= lo && m.yes_price_cents <= hi,
  )!;
}

describe.skipIf(!existsSync(ENGINE))('a Market’s base rates come from the engine, with n and the source (this weekend’s games)', () => {
  for (const league of ['nfl', 'nba'] as const) {
    it(`${league}: the home teams’ rate and the rate of teams priced near this game, each the plain count`, async () => {
      const m = await weekendGame(league);
      const s = spec(m.market_id);
      const plan = defaultPlan(s);
      expect(planProblem(s, plan)).toBeNull();
      const mn = await marketNumbers(markets, s, plan);
      expect(mn.notes ?? []).toEqual([]);
      const p = runnablePlan(plan, mn.numbers);
      const er = engine({ plan: p, numbers: mn.numbers, origins: mn.origins, provenance: mn.provenance });
      expect(er.errors).toEqual([]);
      const h: ResolvedHistory = await markets(MARKETS.resolved, { query: { league, kind: 'game_winner' } });
      const rates = er.numbers.filter((n) => n.op === 'base_rate_history');
      expect(rates.length).toBe(2);
      const [home, band] = rates.map((n) => ({ n, r: er.receipts.find((x) => x.id === n.receipt_id)! }));
      // Home teams: their wins over their games, this season.
      const homes = h.records.filter((r) => r.home);
      expect(home!.r.sample_size).toBe(homes.length);
      expect(home!.n.value).toBeCloseTo(homes.filter((r) => r.outcome === 1).length / homes.length, 8);
      expect(home!.r.origins).toEqual(['history']);
      expect(home!.r.provenance?.history).toEqual({ source: `kalshi:${h.series} settled, home teams, since ${h.season_start}`, as_of: h.as_of });
      // Teams priced within BAND_CENTS of this market before their start.
      const lo = Math.max(0, m.yes_price_cents - BAND_CENTS);
      const hi = Math.min(100, m.yes_price_cents + BAND_CENTS);
      const near = h.records.filter((r) => r.price_cents >= lo && r.price_cents <= hi);
      expect(band!.r.args).toMatchObject({ lo_cents: lo, hi_cents: hi });
      expect(band!.r.sample_size).toBe(near.length);
      expect(band!.n.value).toBeCloseTo(near.filter((r) => r.outcome === 1).length / near.length, 8);
      expect(band!.r.provenance?.lo_cents?.source).toBe(m.market_id);
      expect(band!.r.provenance?.history?.source).toBe(`kalshi:${h.series} settled, every team, since ${h.season_start}`);
      // The example lines (the display words them; here only to show the numbers).
      const pct = (v: number) => Math.round(v * 100);
      process.stdout.write(
        `[base rates] ${m.title} (${m.yes_price_cents}¢): home teams won ${pct(home!.n.value)}% of ${home!.r.sample_size} ${league.toUpperCase()} games on Kalshi this season; ` +
          `teams priced ${lo}-${hi}¢ before the start won ${pct(band!.n.value)}% of ${band!.r.sample_size}\n`,
      );
    });
  }
});

/** markets answering resolved with these records (or this error), and the real fake for everything else. */
function stubMarkets(over: Partial<ResolvedHistory> | CallError): Call {
  return (async (ep: unknown, input: never) => {
    if (ep !== MARKETS.resolved) return markets(ep as never, input);
    if (over instanceof CallError) throw over;
    const h = await markets(MARKETS.resolved, { query: { league: 'nfl', kind: 'game_winner' } });
    return { ...h, ...over };
  }) as unknown as Call;
}

describe('too few settled games: words, no number', () => {
  it('a Market shows the base rates’ keys only with enough games; with too few it says so, with no digits', async () => {
    const m = await weekendGame('nfl');
    const s = spec(m.market_id);
    expect(numberKeys(s)).toEqual(expect.arrayContaining(['home_history', 'band_history', 'band_lo', 'band_hi']));
    const full = await markets(MARKETS.resolved, { query: { league: 'nfl', kind: 'game_winner' } });
    const few = full.records.slice(0, MIN_BASE_RATE_N - 1).map((r) => ({ ...r, home: true, price_cents: 1 }));
    const mn = await marketNumbers(stubMarkets({ records: few }), s, defaultPlan(s));
    for (const k of ['home_history', 'band_history', 'band_lo', 'band_hi']) expect(mn.numbers[k], k).toBeUndefined();
    expect(mn.notes).toEqual([
      'Too few NFL games have settled on Kalshi this season for the home-team base rate.',
      'Too few NFL teams this season were priced near this one before the start for a base rate.',
    ]);
    for (const n of mn.notes!) expect(n).not.toMatch(/\d/);
    // The plan still runs: the base rates' ops drop out (their inputs are missing), everything else stays.
    const p = runnablePlan(defaultPlan(s), mn.numbers);
    expect(p.ops.map((o) => o.op)).not.toContain('base_rate_history');
    expect(p.ops.map((o) => o.op)).toContain('implied_probability');
  });

  it('a game priced where few teams were (a game all but decided) gets the home rate and the words for the other', async () => {
    const m = await weekendGame('nfl', 97, 100);
    if (!m) return; // the recording has no such game
    const s = spec(m.market_id);
    const mn = await marketNumbers(markets, s, defaultPlan(s));
    expect(mn.numbers.home_history).toBeDefined();
    expect(mn.numbers.band_history).toBeUndefined();
    expect(mn.notes).toEqual(['Too few NFL teams this season were priced near this one before the start for a base rate.']);
  });

  it('prices still loading, or the exchange down: says so; other widget types never ask', async () => {
    const m = await weekendGame('nfl');
    const s = spec(m.market_id);
    const loading = await marketNumbers(stubMarkets({ records: [], left_out: { ties: 0, no_price: 0, pending: 200 } }), s, defaultPlan(s));
    expect(loading.notes!.every((n) => /still loading/.test(n))).toBe(true);
    const down = await marketNumbers(stubMarkets(new CallError(503, { error: 'upstream_unavailable', message: 'down' } as never, 'markets.resolved')), s, defaultPlan(s));
    expect(down.notes).toEqual(["No base rates right now: the exchange's settled games aren't answering."]);
    let asked = false;
    const spy = (async (ep: unknown, input: never) => ((asked ||= ep === MARKETS.resolved), markets(ep as never, input))) as unknown as Call;
    const ev = spec(m.market_id, 'events');
    await marketNumbers(spy, ev, defaultPlan(ev));
    expect(asked).toBe(false);
  });
});
