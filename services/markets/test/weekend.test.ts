/**
 * This weekend's games (fixtures/markets/live/weekend): the catalog rows behind them, and markets serving them.
 * Contract: every team that plays has a verified production row with its own feed, and each league has league-wide
 * outlets. Real mode on the recording: list pairs every game, and a game's candidates read both teams' feeds.
 */
import { MARKETS, SOURCE_CATALOG, SourceRow } from '@app/contracts';
import { createLogger } from '@app/service-kit';
import { runCase } from '@app/testkit';
import { describe, expect, it } from 'vitest';
import { parseEventKey } from '../src/games.ts';
import { WEEKEND, realApp, weekendFetch } from './recorded.ts';

const AT = Date.parse(WEEKEND.recorded_at);
const games = WEEKEND.games.map((g) => ({ ...g, game: parseEventKey(g.event_key)! }));
const prod = SOURCE_CATALOG.rows.filter((r) => r.env === 'prod');

describe('the catalog rows behind this weekend’s games', () => {
  it('every recorded game parses into two known teams', () => {
    for (const g of games) expect(g.game, g.event_key).not.toBeNull();
  });

  it('every team that plays has a verified production row with its own team feed', () => {
    for (const { game } of games)
      for (const t of [game.away, game.home]) {
        const rows = prod.filter((r) => r.verified && r.leagues.includes(game.league) && r.feeds.some((f) => f.team === t.code));
        expect(rows.length, `${game.league} ${t.code}`).toBeGreaterThanOrEqual(1);
        for (const r of rows) expect(SourceRow.safeParse(r).success).toBe(true);
      }
  });

  it('each league has at least three verified league-wide outlets', () => {
    for (const league of ['nfl', 'nba'] as const) {
      const wide = prod.filter((r) => r.verified && r.leagues.includes(league) && r.feeds.some((f) => !f.team && f.url.toLowerCase().includes(league)));
      expect(wide.length, league).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('markets serves this weekend’s games (real mode, recorded answers)', () => {
  const setup = () => {
    const rec = weekendFetch();
    return { rec, app: realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search' }, { fetch: rec.fetch, now: () => AT, log: createLogger('markets', 'silent') }) };
  };

  it('list: every recorded game, the away team’s YES on both exchanges', async () => {
    const { app } = setup();
    const out = await runCase(app, MARKETS, { endpoint: 'list', caller: 'board', input: () => ({ query: { category: 'sports' } }) }, {});
    expect(out.problems).toEqual([]);
    const markets = (out.body as { markets: { market_id: string; event_key: string | null; exchange: string }[] }).markets;
    for (const g of games) {
      const mine = markets.filter((m) => m.event_key === g.event_key);
      expect(mine.map((m) => m.market_id), g.event_key).toContain(`kalshi:${g.kalshi}-${g.game.away.kalshi}`);
      expect(mine.map((m) => m.market_id), g.event_key).toContain(`polymarket:${g.polymarket}`);
    }
  });

  it('a game’s candidates read both teams’ feeds and its league’s outlets, never another team’s', async () => {
    const { app, rec } = setup();
    await runCase(app, MARKETS, { endpoint: 'list', caller: 'runner', input: () => ({ query: {} }) }, {});
    for (const g of games.slice(0, 6)) {
      rec.calls.length = 0;
      const out = await runCase(app, MARKETS, { endpoint: 'candidates', caller: 'runner', input: () => ({ params: { market_id: `polymarket:${g.polymarket}` }, query: {} }) }, {});
      expect(out.problems, g.event_key).toEqual([]);
      const teamFeeds = prod.flatMap((r) => r.feeds.filter((f) => f.team && r.leagues.includes(g.game.league)));
      const read = teamFeeds.filter((f) => rec.calls.includes(f.url)).map((f) => f.team);
      expect(read.sort(), g.event_key).toEqual([g.game.away.code, g.game.home.code].sort());
      const receipts = (out.body as { receipts: { provider: string; shared_key: string }[] }).receipts;
      expect(receipts.find((r) => r.provider === 'feeds')?.shared_key).toBe(`feeds:${g.game.league}:${g.game.away.code}-${g.game.home.code}`);
    }
  });
});
