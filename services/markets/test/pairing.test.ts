/**
 * Two prices: this weekend's games (fixtures/markets/live/weekend) paired across Kalshi and Polymarket, both YES
 * meaning the away team wins. Every recorded game pairs; a game whose names disagree anywhere does not, and says why.
 */
import { MARKETS } from '@app/contracts';
import { createLogger } from '@app/service-kit';
import { readFixture, runCase } from '@app/testkit';
import { describe, expect, it } from 'vitest';
import { parseEventKey } from '../src/games.ts';
import { PolyMarketRaw, type PolyMarketRaw as Poly } from '../src/polymarket.ts';
import { pairGame } from '../src/pairing.ts';
import { WEEKEND, realApp, weekendFetch } from './recorded.ts';

const AT = Date.parse(WEEKEND.recorded_at);
const events = ['KXNFLGAME', 'KXNBAGAME'].flatMap(
  (s) => readFixture<{ events: { event_ticker: string; markets: { ticker: string }[] }[] }>(`markets/live/weekend/events-${s}.json`).events,
);
const polys = readFixture<unknown[]>('markets/live/weekend/markets-by-slug.json').map((m) => PolyMarketRaw.parse(m));
const games = WEEKEND.games.map((g) => ({
  ...g,
  game: parseEventKey(g.event_key)!,
  kalshiMarkets: events.find((e) => e.event_ticker === g.kalshi)!.markets,
  poly: polys.find((p) => p.slug === g.polymarket) ?? null,
}));

describe('pairGame on the recorded weekend', () => {
  it('pairs every game: Kalshi <event>-<AWAY> with polymarket:<slug>, YES = the away team wins', () => {
    expect(games.length).toBe(36);
    for (const g of games) {
      expect(pairGame(g.event_key, g.kalshiMarkets, g.poly), g.event_key).toEqual({
        paired: true,
        kalshi: `kalshi:${g.kalshi}-${g.game.away.kalshi}`,
        polymarket: `polymarket:${g.polymarket}`,
        yes_means: `${g.game.away.nickname} win`,
      });
    }
  });

  it('pairs a slug dated by the UTC day (Monday night) by its kickoff’s ET day', () => {
    const mnf = games.find((g) => g.polymarket !== null && !g.polymarket.endsWith(g.game.date));
    expect(mnf, 'a UTC-dated slug in the recording').toBeDefined();
    expect(pairGame(mnf!.event_key, mnf!.kalshiMarkets, mnf!.poly).paired).toBe(true);
  });

  const g = games[0]!;
  const unpaired = (k: { ticker: string }[], p: Poly | null, key = g.event_key) => {
    const r = pairGame(key, k, p);
    expect(r.paired).toBe(false);
    return r.paired ? '' : r.reason;
  };

  it('does not pair when Polymarket lists the teams the other way round', () => {
    const swapped = { ...g.poly!, outcomes: [...g.poly!.outcomes].reverse() };
    expect(unpaired(g.kalshiMarkets, swapped)).toMatch(/other team/);
  });

  it('does not pair without the away team’s Kalshi market, or with two of them', () => {
    const home = g.kalshiMarkets.filter((m) => m.ticker.endsWith(`-${g.game.home.kalshi}`));
    expect(unpaired(home, g.poly)).toMatch(/^Kalshi has no single market on the .+ winning/);
    const away = g.kalshiMarkets.filter((m) => m.ticker.endsWith(`-${g.game.away.kalshi}`));
    expect(unpaired([...away, ...away], g.poly)).toMatch(/^Kalshi/);
  });

  it('does not pair a missing, different or differently dated Polymarket market', () => {
    expect(unpaired(g.kalshiMarkets, null)).toBe('Polymarket has no market for this game.');
    const other = games.find((x) => x.game.league === g.game.league && x.event_key !== g.event_key)!;
    expect(unpaired(g.kalshiMarkets, other.poly)).toMatch(/different game/);
    const later = { ...g.poly!, gameStartTime: '2026-11-15 18:00:00+00' };
    expect(unpaired(g.kalshiMarkets, later)).toMatch(/different days/);
  });

  it('does not pair an event key it cannot name', () => {
    expect(unpaired(g.kalshiMarkets, g.poly, 'nfl-2026w10-kc-buf')).toMatch(/can't name/);
  });
});

describe('markets’ event endpoint carries the pairing (real mode, recorded answers)', () => {
  it('every recorded game: both markets, and the pair a gap compares', async () => {
    const rec = weekendFetch();
    const app = realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search' }, { fetch: rec.fetch, now: () => AT, log: createLogger('markets', 'silent') });
    for (const g of games) {
      const out = await runCase(app, MARKETS, { endpoint: 'event', caller: 'runner', input: () => ({ params: { event_key: g.event_key } }) }, {});
      expect(out.problems, g.event_key).toEqual([]);
      const body = out.body as { markets: { market_id: string }[]; pairing: { paired: boolean; kalshi?: string; polymarket?: string } };
      expect(body.pairing, g.event_key).toMatchObject({ paired: true, kalshi: `kalshi:${g.kalshi}-${g.game.away.kalshi}`, polymarket: `polymarket:${g.polymarket}` });
      expect(body.markets.map((m) => m.market_id)).toEqual(expect.arrayContaining([body.pairing.kalshi, body.pairing.polymarket]));
    }
    // Polite: one Kalshi event read and at most two Polymarket slug reads per game, nothing else.
    expect(rec.calls.length).toBeLessThanOrEqual(games.length * 3);
  });
});
