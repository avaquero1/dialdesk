/**
 * Price history for moves and the 7-day line (N1.1.3), real mode on this weekend's recording
 * (fixtures/markets/live/weekend/history): every game's two markets, one polite fetch per market, cut to the window.
 */
import { MARKETS } from '@app/contracts';
import { createLogger } from '@app/service-kit';
import { runCase } from '@app/testkit';
import { describe, expect, it } from 'vitest';
import { spacer } from '../src/real.ts';
import { UpstreamError } from '../src/upstream.ts';
import { WEEKEND_HISTORY, realApp, weekendFetch } from './recorded.ts';

const AT = Date.parse(WEEKEND_HISTORY.recorded_at);
const DAY = 86400;
type Hist = { market_id: string; points: { t: number; price_cents: number }[]; as_of: string };

const setup = (cfg: Record<string, unknown> = {}) => {
  const rec = weekendFetch();
  const app = realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search', HISTORY_PER_MIN: 6000, ...cfg }, { fetch: rec.fetch, now: () => AT, log: createLogger('markets', 'silent') });
  const history = async (market_id: string, window_s: number) => {
    const out = await runCase(app, MARKETS, { endpoint: 'history', caller: 'runner', input: () => ({ params: { market_id }, query: { window_s } }) }, {});
    return { ...out, body: out.body as Hist };
  };
  return { rec, history };
};

describe('markets serves each game’s price history (recorded)', () => {
  it('every recorded game’s two markets: points sorted, prices 0..100, inside 7 days, as of the fetch', async () => {
    const { history } = setup();
    expect(WEEKEND_HISTORY.files.length).toBe(72);
    for (const { market_id } of WEEKEND_HISTORY.files) {
      const h = await history(market_id, 7 * DAY);
      expect(h.problems, market_id).toEqual([]);
      const pts = h.body.points;
      expect(pts.length, market_id).toBeGreaterThan(24);
      for (let i = 1; i < pts.length; i++) expect(pts[i]!.t).toBeGreaterThanOrEqual(pts[i - 1]!.t);
      for (const p of pts) {
        expect(p.price_cents).toBeGreaterThanOrEqual(0);
        expect(p.price_cents).toBeLessThanOrEqual(100);
        expect(p.t).toBeGreaterThanOrEqual(pts.at(-1)!.t - 7 * DAY);
        expect(p.t).toBeLessThanOrEqual(AT / 1000 + 3600);
      }
      expect(h.body.as_of).toBe(WEEKEND_HISTORY.recorded_at);
    }
  });

  it('one fetch per market serves the 24 h and the 7-day windows, and a second ask is cached', async () => {
    const { rec, history } = setup();
    const id = WEEKEND_HISTORY.files.find((f) => f.market_id.startsWith('kalshi:'))!.market_id;
    const week = await history(id, 7 * DAY);
    const day = await history(id, DAY);
    await history(id, 7 * DAY);
    expect(rec.calls.filter((u) => u.includes('/candlesticks')).length).toBe(1);
    expect(day.body.points.length).toBeGreaterThan(0);
    expect(day.body.points.length).toBeLessThan(week.body.points.length);
    const last = week.body.points.at(-1)!.t;
    expect(day.body.points.every((p) => p.t >= last - DAY)).toBe(true);
    expect(day.body.points).toEqual(week.body.points.filter((p) => p.t >= last - DAY));
    expect(day.body.points.at(-1)).toEqual(week.body.points.at(-1));
  });

  it('Polymarket’s history comes from the CLOB by the moneyline’s first token', async () => {
    const { rec, history } = setup();
    const id = WEEKEND_HISTORY.files.find((f) => f.market_id.startsWith('polymarket:'))!.market_id;
    const h = await history(id, 7 * DAY);
    expect(h.problems).toEqual([]);
    expect(h.body.points.length).toBeGreaterThan(24);
    const clob = rec.calls.filter((u) => u.startsWith('https://clob.polymarket.com/prices-history'));
    expect(clob.length).toBe(1);
    expect(clob[0]).toContain('interval=1w');
  });

  it('polite: a burst past the per-minute budget is refused (503 with nothing cached), not sent', async () => {
    const { rec, history } = setup({ HISTORY_PER_MIN: 1, HISTORY_MAX_WAIT_S: 0 });
    const kalshi = WEEKEND_HISTORY.files.filter((f) => f.market_id.startsWith('kalshi:')).slice(0, 3);
    const out = await Promise.all(kalshi.map((f) => history(f.market_id, DAY)));
    expect(out.map((o) => o.status)).toEqual([200, 503, 503]);
    expect(rec.calls.filter((u) => u.includes('/candlesticks')).length).toBe(1);
  });
});

describe('spacer', () => {
  it('spaces calls gapMs apart and refuses one whose turn is past maxWaitMs', async () => {
    let t = 1_000;
    const s = spacer(50, 120, () => t);
    const started: number[] = [];
    const run = () => s.run('api.example', async () => void started.push(Date.now()));
    const t0 = Date.now();
    await Promise.all([run(), run(), run()]); // turns at +0, +50, +100 (all within 120)
    expect(started.length).toBe(3);
    expect(started[2]! - t0).toBeGreaterThanOrEqual(90);
    await expect(run()).rejects.toBeInstanceOf(UpstreamError); // the clock didn't move: next turn is +150
    t += 1_000;
    await expect(run()).resolves.toBeUndefined();
  });
});
