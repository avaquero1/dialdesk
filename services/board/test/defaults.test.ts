/**
 * The prescribed first board from markets' list (src/defaults.ts): which games go where, on made-up markets.
 * The same rules on the exchanges' recorded answers: first-paint.test.ts.
 */
import { DefaultTile, WIDGET_CATALOG, type Market } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { validateDisplay } from '../src/logic.ts';
import { addDrafts, draftsFor, fixtureOnly, gameLabel, gamesOf, nbaNight, nflWeek, prescribedTiles, weekBoard } from '../src/defaults.ts';
import { defaultDraft } from '@app/contracts';
import { marketsForBoard } from './cases.ts';

const AT = '2026-11-07T20:00:00Z';
function market(id: string, event_key: string, title: string, volume = 10, close_time: string | null = null): Market {
  return {
    market_id: id as Market['market_id'],
    exchange: id.startsWith('kalshi:') ? 'kalshi' : 'polymarket',
    event_key,
    title,
    category: 'sports',
    league: event_key.slice(0, 3) as Market['league'],
    yes_price_cents: 50,
    yes_bid_cents: 49,
    yes_ask_cents: 51,
    previous_price_cents: null,
    volume,
    close_time,
    as_of: AT,
    stale: false,
  };
}
/** A game on both exchanges: Kalshi's two team markets and Polymarket's moneyline (YES = away). */
function game(league: 'nfl' | 'nba', date: string, away: [string, string], home: [string, string], volume = 10, start: string | null = null): Market[] {
  const key = `${league}-${date}-${away[0]}-${home[0]}`;
  const [y, m, d] = date.split('-');
  const ev = `KX${league.toUpperCase()}GAME-${y!.slice(2)}${['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(m)]}${d}${away[0].toUpperCase()}${home[0].toUpperCase()}`;
  const t = `${away[1]} at ${home[1]}`;
  return [
    market(`kalshi:${ev}-${away[0].toUpperCase()}`, key, `${t}: ${away[1]} win`, volume),
    market(`kalshi:${ev}-${home[0].toUpperCase()}`, key, `${t}: ${home[1]} win`, volume),
    market(`polymarket:${league}-${away[0]}-${home[0]}-${date}`, key, `${t}: ${away[1]} win`, volume, start),
  ];
}

const LIST: Market[] = [
  ...game('nba', '2026-11-06', ['lal', 'Lakers'], ['bos', 'Celtics']), // last night: never on the board
  ...game('nba', '2026-11-07', ['nyk', 'Knicks'], ['cle', 'Cavaliers'], 50, '2026-11-08T01:00:00Z'),
  ...game('nba', '2026-11-07', ['bkn', 'Nets'], ['atl', 'Hawks'], 5, '2026-11-08T00:30:00Z'),
  ...game('nba', '2026-11-08', ['phi', 'Sixers'], ['chi', 'Bulls'], 500),
  ...game('nfl', '2026-11-08', ['nyj', 'Jets'], ['kc', 'Chiefs'], 900, '2026-11-08T18:00:00Z'),
  ...game('nfl', '2026-11-08', ['tb', 'Buccaneers'], ['chi', 'Bears'], 100, '2026-11-09T01:20:00Z'),
  ...game('nfl', '2026-11-09', ['buf', 'Bills'], ['min', 'Vikings'], 300, '2026-11-10T01:15:00Z'),
  ...game('nfl', '2026-11-12', ['was', 'Commanders'], ['nyg', 'Giants'], 999), // next week's Thursday game
  market('kalshi:KXNBA-26-BOS', 'nba-2026-champion', 'Pro Basketball Champion: Boston'), // a future, not a game
];
const displays = (tiles: DefaultTile[]) => tiles.flatMap((t) => (t.kind === 'display' ? [t] : t.kind === 'folder' ? t.children : []));

describe('board: the prescribed first board from this week’s games', () => {
  it('groups the list into games, keeping the away team’s Kalshi market so both YES mean the same', () => {
    const g = gamesOf(LIST).find((x) => x.event_key === 'nfl-2026-11-08-nyj-kc')!;
    expect(g).toMatchObject({ title: 'Jets at Chiefs', away: 'Jets', home: 'Chiefs', kalshi: 'kalshi:KXNFLGAME-26NOV08NYJKC-NYJ', polymarket: 'polymarket:nfl-nyj-kc-2026-11-08' });
    expect(gamesOf(LIST).some((x) => x.event_key === 'nba-2026-champion')).toBe(false);
  });

  it('the NFL week runs through Monday night; the NBA night is tonight', () => {
    expect(nflWeek(gamesOf(LIST), '2026-11-07').map((g) => g.event_key)).toEqual(['nfl-2026-11-08-nyj-kc', 'nfl-2026-11-08-tb-chi', 'nfl-2026-11-09-buf-min']);
    expect(nbaNight(gamesOf(LIST), '2026-11-07')!.games.map((g) => g.event_key)).toEqual(['nba-2026-11-07-bkn-atl', 'nba-2026-11-07-nyk-cle']);
    expect(nbaNight(gamesOf(LIST), '2026-11-08')!.date).toBe('2026-11-08');
  });

  it('fills the catalog’s shape: Tonight, a market, Two prices, News, Positions, Biggest move, two folders, five apps', () => {
    const tiles = weekBoard(LIST, Date.parse(AT))!;
    const shape = (t: DefaultTile) => (t.kind === 'display' ? t.type : t.kind === 'app' ? t.app : `folder:${t.title}`);
    expect(tiles.map(shape)).toEqual(
      WIDGET_CATALOG.default_board.tiles.map(shape).map((s) => (s === 'folder:NFL Week 10' ? 'folder:NFL this week' : s === 'folder:NBA Tonight' ? 'folder:NBA tonight' : s)),
    );
    const by = (type: string) => displays(tiles).find((d) => d.type === type)!;
    expect(by('events').params.event_keys).toEqual(['nba-2026-11-07-bkn-atl', 'nba-2026-11-07-nyk-cle', 'nfl-2026-11-08-nyj-kc', 'nfl-2026-11-08-tb-chi', 'nfl-2026-11-09-buf-min']);
    expect(by('probability')).toMatchObject({ title: 'Jets beat the Chiefs', market_ids: ['kalshi:KXNFLGAME-26NOV08NYJKC-NYJ', 'polymarket:nfl-nyj-kc-2026-11-08'] });
    expect(by('probability').params.user_probability).toBeUndefined();
    expect(by('gap').market_ids).toEqual(by('probability').market_ids);
    expect(by('news')).toMatchObject({ title: 'Chiefs news', params: { team: 'Chiefs' } });
    // Biggest move compares the board's games: the NBA's most traded first, then the rest of Tonight's.
    expect(by('movement').params.event_keys).toEqual(['nba-2026-11-07-nyk-cle', 'nba-2026-11-07-bkn-atl', 'nfl-2026-11-08-nyj-kc', 'nfl-2026-11-08-tb-chi', 'nfl-2026-11-09-buf-min']);
    expect(by('movement').market_ids).toHaveLength(5);
    expect(by('movement').market_ids[0]).toMatch(/NYKCLE|nyk-cle/);
    const folders = tiles.filter((t) => t.kind === 'folder');
    expect(folders.map((f) => f.children.map((c) => c.title))).toEqual([
      ['Jets at Chiefs', 'Buccaneers at Bears', 'Bills at Vikings'],
      ['Nets at Hawks', 'Knicks at Cavaliers'],
    ]);
  });

  it('every prescribed display passes the catalog’s checks', () => {
    const tiles = weekBoard(LIST, Date.parse(AT))!;
    for (const t of tiles) DefaultTile.parse(t);
    for (const d of displays(tiles)) expect(() => validateDisplay(d)).not.toThrow();
  });

  it('names the NBA folder by its day when there are no games tonight, and leaves out an empty folder', () => {
    const noTonight = LIST.filter((m) => !m.event_key?.startsWith('nba-2026-11-07'));
    const folders = (tiles: DefaultTile[] | null) => tiles!.filter((t) => t.kind === 'folder').map((t) => t.title);
    expect(folders(weekBoard(noTonight, Date.parse(AT)))).toEqual(['NFL this week', 'NBA tomorrow']);
    expect(folders(weekBoard(noTonight, Date.parse('2026-11-08T15:00:00Z')))).toEqual(['NFL this week', 'NBA tonight']);
    expect(folders(weekBoard(noTonight.filter((m) => !m.event_key?.startsWith('nba-')), Date.parse(AT)))).toEqual(['NFL this week']);
  });

  it('no games ahead, no markets, or markets down: the catalog’s own board', async () => {
    expect(weekBoard([], Date.parse(AT))).toBeNull();
    expect(await prescribedTiles(undefined, Date.parse(AT))).toBe(WIDGET_CATALOG.default_board.tiles);
    const down = (async () => {
      throw new Error('503');
    }) as never;
    expect(await prescribedTiles(down, Date.parse(AT))).toBe(WIDGET_CATALOG.default_board.tiles);
  });

  it('markets’ fake (the catalog’s made-up fixture games): the catalog’s own board, as the other pieces expect', async () => {
    expect(fixtureOnly(LIST)).toBe(false);
    expect(await prescribedTiles(marketsForBoard(), Date.parse(AT))).toBe(WIDGET_CATALOG.default_board.tiles);
  });
});

describe('board: the Add app’s drafts on this week’s games (W1.2.6)', () => {
  const now = Date.parse(AT);
  const board = () => displays(weekBoard(LIST, now)!);

  it('a market card: the first board’s game first, then this week’s other games, most traded first, in plain words', () => {
    const d = addDrafts(LIST, 'probability', now);
    // The NBA's next night only (tonight), as on the first board; tomorrow's Sixers at Bulls is not this week's pick.
    expect(d.map((x) => x.event_key)).toEqual(['nfl-2026-11-08-nyj-kc', 'nfl-2026-11-09-buf-min', 'nfl-2026-11-08-tb-chi', 'nba-2026-11-07-nyk-cle', 'nba-2026-11-07-bkn-atl']);
    expect(d.map((x) => x.label)).toEqual(['Jets at Chiefs, Sun 1 PM', 'Bills at Vikings, Mon 8:15 PM', 'Buccaneers at Bears, Sun 8:20 PM', 'Knicks at Cavaliers, Sat 8 PM', 'Nets at Hawks, Sat 7:30 PM']);
    const tile = board().find((t) => t.type === 'probability')!;
    expect(d[0]!.widget).toEqual({ kind: 'display', type: 'probability', size: defaultDraft('probability').size, title: tile.title, market_ids: tile.market_ids, params: tile.params });
    expect(d[1]!.widget).toMatchObject({ type: 'probability', title: 'Bills beat the Vikings', params: { event_keys: ['nfl-2026-11-09-buf-min'] } });
    for (const x of d) validateDisplay(x.widget);
  });

  it('News follows the picked game’s home team; Two prices only offers games on both exchanges', () => {
    expect(addDrafts(LIST, 'news', now)[1]!.widget).toMatchObject({ title: 'Vikings news', params: { team: 'Vikings' } });
    const one = LIST.filter((m) => !(m.event_key === 'nfl-2026-11-09-buf-min' && m.exchange === 'polymarket'));
    expect(addDrafts(one, 'gap', now).map((x) => x.event_key)).not.toContain('nfl-2026-11-09-buf-min');
    for (const x of addDrafts(one, 'gap', now)) expect(x.widget.market_ids).toHaveLength(2);
  });

  it('Tonight and Biggest move: one draft, the first board’s own games', () => {
    for (const type of ['events', 'movement'] as const) {
      const d = addDrafts(LIST, type, now);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ event_key: null, widget: { market_ids: board().find((t) => t.type === type)!.market_ids } });
    }
  });

  it('a game with no start time is labelled with its day', () => {
    expect(gameLabel({ ...gamesOf(LIST)[0]!, starts_at: null })).toBe('Lakers at Celtics, Fri');
  });

  it('no games ahead, markets down, or markets’ fake: the catalog’s draft, as before', async () => {
    const catalog = [{ event_key: null, label: defaultDraft('probability').title, widget: defaultDraft('probability') }];
    expect(addDrafts([], 'probability', now)).toEqual(catalog);
    expect(await draftsFor(undefined, 'probability', now)).toEqual(catalog);
    expect(await draftsFor((async () => { throw new Error('503'); }) as never, 'probability', now)).toEqual(catalog);
    expect(await draftsFor(marketsForBoard(), 'probability', now)).toEqual(catalog);
  });
});
