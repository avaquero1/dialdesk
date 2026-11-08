/**
 * Settled games for base rates (N1.1.4), real mode on the recording (fixtures/markets/live/weekend/resolved): this
 * season's NFL and NBA game winners on Kalshi, each priced at its last hourly price before the start, fetched politely
 * (one list per league, then one candles batch per game day, kept for good) and the same answer the fake gives.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKETS, type ResolvedHistory } from '@app/contracts';
import { createLogger } from '@app/service-kit';
import { FIXTURES_DIR, runCase } from '@app/testkit';
import { describe, expect, it } from 'vitest';
import { recordedResolved } from '../src/fake.ts';
import { KalshiSettledPage, kalshiGameStart } from '../src/kalshi.ts';
import { dayChunks, settledGames } from '../src/resolved.ts';
import { SEASON_START } from '../src/teams.ts';
import { WEEKEND_RESOLVED, realApp, weekendFetch } from './recorded.ts';

const AT = Date.parse(WEEKEND_RESOLVED.recorded_at);
const settled = (series: string) =>
  KalshiSettledPage.parse(JSON.parse(readFileSync(join(FIXTURES_DIR, 'markets/live/weekend/resolved', `settled-${series}.json`), 'utf8'))).markets;

const setup = (cfg: Record<string, unknown> = {}) => {
  const rec = weekendFetch();
  const app = realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search', RESOLVED_PER_MIN: 6000, RESOLVED_WAIT_S: 30, ...cfg }, { fetch: rec.fetch, now: () => AT, log: createLogger('markets', 'silent') });
  const resolved = async (league: string) => {
    const out = await runCase(app, MARKETS, { endpoint: 'resolved', caller: 'runner', input: () => ({ query: { league } }) }, {});
    return { ...out, body: out.body as ResolvedHistory };
  };
  const count = (part: string) => rec.calls.filter((u) => u.includes(part)).length;
  return { rec, resolved, count };
};

describe('settled games, by code from Kalshi’s tickers', () => {
  it('a game starts 48 h before Kalshi’s latest expiration (the NFL’s 1:00 PM ET Sunday kickoff)', () => {
    const m = settled('KXNFLGAME').find((x) => x.ticker === 'KXNFLGAME-26NOV01ATLTB-TB')!;
    expect(new Date(kalshiGameStart(m) * 1000).toISOString()).toBe('2026-11-01T18:00:00.000Z');
  });

  it('this season only, home and away right, ties counted apart', () => {
    for (const [league, series] of [['nfl', 'KXNFLGAME'], ['nba', 'KXNBAGAME']] as const) {
      const raw = settled(series);
      const s = settledGames(league, raw);
      expect(s.games.length, league).toBeGreaterThan(100);
      for (const g of s.games) expect(g.day >= SEASON_START[league], g.ticker).toBe(true);
      // Every game is two markets, one home and one away, and (bar a tie) exactly one of them won.
      const byEvent = new Map<string, typeof s.games>();
      for (const g of s.games) byEvent.set(g.event_key, [...(byEvent.get(g.event_key) ?? []), g]);
      let ties = 0;
      for (const [key, two] of byEvent) {
        expect(two.length, key).toBe(2);
        expect(two.filter((g) => g.home).length, key).toBe(1);
        if (two.some((g) => g.outcome === null)) ties++;
        else expect(two[0]!.outcome! + two[1]!.outcome!, key).toBe(1);
      }
      expect(s.ties).toBe(ties);
    }
    // The preseason is out: NBA preseason games settled before Oct 20 are in the list but not counted.
    expect(settled('KXNBAGAME').some((m) => m.ticker.includes('26OCT16'))).toBe(true);
  });
});

describe('markets.resolved (recorded)', () => {
  it('every settled game priced before its start, engine-ready, the same answer as the fake', async () => {
    const { resolved } = setup();
    for (const league of ['nfl', 'nba']) {
      const h = await resolved(league);
      expect(h.problems, league).toEqual([]);
      expect(h.status).toBe(200);
      const b = h.body;
      expect(b.left_out.pending, league).toBe(0);
      expect(b.records.length, league).toBeGreaterThan(150);
      for (const r of b.records) {
        expect(r.price_cents).toBeGreaterThan(0);
        expect(r.price_cents).toBeLessThan(100);
        expect([0, 1]).toContain(r.outcome);
      }
      // A price before the start is a real pre-game price: favourites (above 50) win more often than not.
      const fav = b.records.filter((r) => r.price_cents > 60);
      expect(fav.filter((r) => r.outcome === 1).length / fav.length, league).toBeGreaterThan(0.55);
      expect(b).toEqual({ ...recordedResolved(league as 'nfl' | 'nba'), as_of: b.as_of });
    }
  });

  it('polite: one settled list per league, one candles batch per game day, each kept (a second call fetches nothing)', async () => {
    const { resolved, count } = setup();
    await resolved('nfl');
    await resolved('nba');
    const chunks = ['nfl', 'nba'].map((l) => dayChunks(settledGames(l as 'nfl', settled(l === 'nfl' ? 'KXNFLGAME' : 'KXNBAGAME')).games).length);
    expect(count('status=settled')).toBe(2);
    expect(count('/markets/candlesticks')).toBe(chunks[0]! + chunks[1]!);
    expect(count('/markets/candlesticks')).toBe(WEEKEND_RESOLVED.files.length);
    await resolved('nfl');
    await resolved('nba');
    expect(count('status=settled')).toBe(2);
    expect(count('/markets/candlesticks')).toBe(WEEKEND_RESOLVED.files.length);
  });

  it('a request waits only its budget: the rest is fetched in the background and counted as pending', async () => {
    const { resolved } = setup({ RESOLVED_WAIT_S: 0, RESOLVED_PER_MIN: 600 });
    const first = await resolved('nba');
    expect(first.problems).toEqual([]);
    expect(first.body.left_out.pending).toBeGreaterThan(0);
    let last = first.body;
    for (let i = 0; i < 100 && last.left_out.pending > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      last = (await resolved('nba')).body;
    }
    expect(last.left_out.pending).toBe(0);
    expect(last.records.length).toBeGreaterThan(first.body.records.length);
  });

  it('a league markets doesn’t cover is a 404; Kalshi down with nothing cached is a 503', async () => {
    const { resolved } = setup();
    expect((await resolved('mlb')).status).toBe(404);
    const down = realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search' }, { fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch, now: () => AT, log: createLogger('markets', 'silent') });
    const out = await runCase(down, MARKETS, { endpoint: 'resolved', caller: 'runner', input: () => ({ query: { league: 'nfl' } }) }, {});
    expect(out.status).toBe(503);
  });
});

describe('the engine’s copy of the recording', () => {
  it('engine-history.json is the recording in the engine’s shape (what engine/tests/recorded_history.rs reads)', async () => {
    const { engineHistory } = await import('../src/fake.ts');
    const file = JSON.parse(readFileSync(join(FIXTURES_DIR, 'markets/live/weekend/resolved/engine-history.json'), 'utf8'));
    expect(file).toEqual(engineHistory());
  });
});
