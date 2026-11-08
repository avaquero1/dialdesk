/**
 * The prescribed first board, filled with this week's real games (design.md section 6): Tonight, one market, Two prices,
 * team News, Your account, Biggest move, and the folders "NFL this week" and "NBA tonight".
 *
 * The catalog's default board (WIDGET_CATALOG.default_board) gives the shape and each tile's params. At sign-up board asks
 * markets for the open NFL and NBA games and puts them in that shape. When markets has no games ahead, is down, or lists
 * only the catalog's made-up fixture markets (its fake), the catalog's own tiles are the board.
 */
import { defaultDraft, MARKETS, WIDGET_CATALOG, type AddDraft, type DefaultTile, type DisplayType, type Market } from '@app/contracts';
import type { Call } from '@app/service-kit';

type DisplayTile = Extract<DefaultTile, { kind: 'display' }>;

/** One game from markets' list: its event key, its "Away at Home" title and the YES-away-wins market on each exchange. */
export interface Game {
  event_key: string;
  league: 'nfl' | 'nba';
  /** the game's ET date, YYYY-MM-DD (from the event key) */
  date: string;
  title: string;
  away: string;
  home: string;
  kalshi: string | null;
  polymarket: string | null;
  /** kickoff or tip-off when an exchange gives it (Polymarket's end date is the start), else null */
  starts_at: string | null;
  volume: number;
}

/** markets' event keys for games: nfl-2026-11-08-nyj-kc (league, ET date, away code, home code). */
const GAME_KEY = /^(nfl|nba)-(\d{4}-\d{2}-\d{2})-([a-z0-9]{2,4})-([a-z0-9]{2,4})$/;

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export const etDate = (ms: number) => ET.format(new Date(ms));
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Groups markets' list into games. Markets that aren't a dated NFL or NBA game are left out. */
export function gamesOf(markets: Market[]): Game[] {
  const byKey = new Map<string, Game>();
  for (const m of markets) {
    const k = m.event_key ? GAME_KEY.exec(m.event_key) : null;
    if (!k || m.category !== 'sports') continue;
    const title = m.title.split(':')[0]!.trim();
    const [away, home] = title.split(' at ');
    if (!away || !home) continue;
    const g = byKey.get(m.event_key!) ?? {
      event_key: m.event_key!,
      league: k[1] as Game['league'],
      date: k[2]!,
      title,
      away,
      home,
      kalshi: null,
      polymarket: null,
      starts_at: null,
      volume: 0,
    };
    // Kalshi lists one market per team: keep the away team's, so both exchanges' YES means the same thing.
    if (m.exchange === 'kalshi' && m.market_id.endsWith(`-${k[3]!.toUpperCase()}`)) {
      g.kalshi = m.market_id;
      g.volume += m.volume;
    }
    if (m.exchange === 'polymarket') {
      g.polymarket = m.market_id;
      g.starts_at = m.close_time;
      g.volume += m.volume;
    }
    byKey.set(g.event_key, g);
  }
  return [...byKey.values()].filter((g) => g.kalshi || g.polymarket);
}

const byStart = (a: Game, b: Game) => a.date.localeCompare(b.date) || (a.starts_at ?? '~').localeCompare(b.starts_at ?? '~') || a.event_key.localeCompare(b.event_key);
const byVolume = (a: Game, b: Game) => b.volume - a.volume || byStart(a, b);
const ids = (g: Game) => [g.kalshi, g.polymarket].filter((x): x is string => !!x);

/** This NFL week: from today to the Tuesday after the next game day (Sunday and Monday night stay in one week). */
export function nflWeek(games: Game[], today: string): Game[] {
  const next = games.filter((g) => g.league === 'nfl' && g.date >= today).sort(byStart);
  if (!next.length) return [];
  const first = next[0]!.date;
  const dow = new Date(`${first}T12:00:00Z`).getUTCDay();
  const tuesday = addDays(first, ((2 - dow + 7) % 7) || 7);
  return next.filter((g) => g.date < tuesday);
}

/** The NBA's next game day: tonight when there are games tonight. */
export function nbaNight(games: Game[], today: string): { date: string; games: Game[] } | null {
  const next = games.filter((g) => g.league === 'nba' && g.date >= today).sort(byStart);
  if (!next.length) return null;
  const date = next[0]!.date;
  return { date, games: next.filter((g) => g.date === date) };
}

/** The games a board built now is filled with (null: no NFL and no NBA games ahead). */
export interface WeekPicks {
  today: string;
  nfl: Game[];
  nba: { date: string; games: Game[] } | null;
  /** the NFL week's most traded game (the NBA's when there is no NFL week): the market, Two prices, News */
  featured: Game;
  /** the NBA night's most traded game: Biggest move's first */
  mover: Game;
  /** the three most traded games of the NBA's next night and of the NFL week, by start */
  tonight: Game[];
}

export function weekPicks(markets: Market[], now: number): WeekPicks | null {
  const today = etDate(now);
  const games = gamesOf(markets);
  const nfl = nflWeek(games, today);
  const nba = nbaNight(games, today);
  if (!nfl.length && !nba) return null;
  const nbaGames = nba?.games ?? [];
  const featured = [...nfl].sort(byVolume)[0] ?? [...nbaGames].sort(byVolume)[0]!;
  const mover = [...nbaGames].sort(byVolume)[0] ?? featured;
  const tonight = [...[...nbaGames].sort(byVolume).slice(0, 3), ...[...nfl].sort(byVolume).slice(0, 3)].sort(byStart);
  return { today, nfl, nba, featured, mover, tonight };
}

/**
 * The catalog's default board with this week's games in it, or null when there are no NFL and no NBA games ahead.
 * Tonight: the three most traded games of the NBA's next night and of the NFL week, by start. The market, Two prices and
 * News follow the NFL week's most traded game (the NBA's when there is no NFL week). Biggest move compares the NBA's most
 * traded game and Tonight's games.
 */
export function weekBoard(markets: Market[], now: number, catalog: DefaultTile[] = WIDGET_CATALOG.default_board.tiles): DefaultTile[] | null {
  const pick = weekPicks(markets, now);
  if (!pick) return null;
  const { today, nfl, nba } = pick;
  const nbaGames = nba?.games ?? [];
  const nbaTitle = !nba ? 'NBA tonight' : nba.date === today ? 'NBA tonight' : nba.date === addDays(today, 1) ? 'NBA tomorrow' : `NBA ${weekday(nba.date)}`;
  const card = (g: Game): DisplayTile => ({ kind: 'display', type: 'probability', size: 'S', title: g.title, market_ids: ids(g), params: { event_keys: [g.event_key] } });

  const out: DefaultTile[] = [];
  let folder = 0;
  for (const t of catalog) {
    if (t.kind === 'app') out.push(t);
    else if (t.kind === 'folder') {
      // The catalog's first folder is the NFL's, the second the NBA's.
      const [title, list] = folder++ === 0 ? ['NFL this week', nfl] : [nbaTitle, nbaGames];
      if (list.length) out.push({ kind: 'folder', title, children: [...list].sort(byStart).slice(0, 24).map(card) });
    } else out.push(fillTile(t, pick));
  }
  return out;
}

/** One of the catalog's display tiles on this week's games. */
export function fillTile(t: DisplayTile, { featured, mover, tonight }: Pick<WeekPicks, 'featured' | 'mover' | 'tonight'>): DisplayTile {
  const { user_probability: _mine, ...params } = t.params; // a new trader has given no number of their own yet
  switch (t.type) {
    case 'events':
      return { ...t, market_ids: tonight.map((g) => g.kalshi ?? g.polymarket!), params: { ...params, event_keys: tonight.map((g) => g.event_key) } };
    case 'probability':
      return { ...t, title: `${featured.away} beat the ${featured.home}`, market_ids: ids(featured), params: { ...params, event_keys: [featured.event_key] } };
    case 'gap':
      return { ...t, market_ids: ids(featured), params: { ...params, event_keys: [featured.event_key] } };
    case 'news':
      return { ...t, title: `${featured.home} news`, market_ids: ids(featured), params: { ...params, team: featured.home, event_keys: [featured.event_key] } };
    case 'movement': {
      // Biggest move compares the board's games: the NBA's most traded first, then Tonight's (one market per game).
      const games = [mover, ...tonight.filter((g) => g.event_key !== mover.event_key)];
      return { ...t, market_ids: games.map((g) => g.kalshi ?? g.polymarket!), params: { ...params, event_keys: games.map((g) => g.event_key) } };
    }
    default:
      return t;
  }
}

/** The displays that follow one game: Add asks "Which game?" for these. */
export const ONE_GAME: readonly DisplayType[] = ['probability', 'gap', 'news'];

const TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
/** "Jets at Chiefs, Sun 1 PM" (ET; the day alone when no exchange gives the start). */
export function gameLabel(g: Game): string {
  if (!g.starts_at || Number.isNaN(Date.parse(g.starts_at))) return `${g.title}, ${weekday(g.date).slice(0, 3)}`;
  const p = Object.fromEntries(TIME.formatToParts(new Date(g.starts_at)).map((x) => [x.type, x.value]));
  return `${g.title}, ${p.weekday} ${p.hour}${p.minute === '00' ? '' : `:${p.minute}`} ${p.dayPeriod}`;
}

/**
 * The Add app's drafts for one display type, the way the first board picks this week's games (weekBoard): the default
 * first (the board's own tile: the most traded game, tonight's games). A one-game display (ONE_GAME) then lists this
 * week's other games, most traded first (Two prices: only games on both exchanges). No games ahead or only fixture
 * markets: the catalog's draft (defaultDraft), as before.
 */
export function addDrafts(markets: Market[] | null, type: DisplayType, now: number): AddDraft[] {
  const fallback: AddDraft[] = [{ event_key: null, label: defaultDraft(type).title, widget: defaultDraft(type) }];
  const pick = markets && !fixtureOnly(markets) ? weekPicks(markets, now) : null;
  const tile = WIDGET_CATALOG.default_board.tiles.find((t): t is DisplayTile => t.kind === 'display' && t.type === type);
  if (!pick || !tile) return fallback;
  const draft = (t: DisplayTile) => ({ ...defaultDraft(type), title: t.title, market_ids: [...t.market_ids], params: { ...t.params } });
  if (!ONE_GAME.includes(type)) {
    const d = draft(fillTile(tile, pick));
    return [{ event_key: null, label: d.title, widget: d }];
  }
  const fits = (g: Game) => (type === 'gap' ? !!(g.kalshi && g.polymarket) : true);
  const week = [...pick.nfl, ...(pick.nba?.games ?? [])].filter(fits).sort(byVolume);
  const first = fits(pick.featured) ? pick.featured : week[0];
  if (!first) return fallback;
  return [first, ...week.filter((g) => g.event_key !== first.event_key)]
    .slice(0, 12)
    .map((g) => ({ event_key: g.event_key, label: gameLabel(g), widget: draft(fillTile(tile, { ...pick, featured: g })) }));
}

/** addDrafts on markets' list now. Waits at most timeoutMs for markets, then gives the catalog's draft. */
export async function draftsFor(markets: Call | undefined, type: DisplayType, now: number, timeoutMs = 3000): Promise<AddDraft[]> {
  if (!markets) return addDrafts(null, type, now);
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs).unref());
  const got = await Promise.race([markets(MARKETS.list, { query: { category: 'sports' } }).catch(() => null), timeout]);
  return addDrafts(got?.markets ?? null, type, now);
}

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

/** The tiles a new board starts with: this week's games from markets, else the catalog's. Waits at most timeoutMs. */
export async function prescribedTiles(markets: Call | undefined, now: number, timeoutMs = 3000): Promise<DefaultTile[]> {
  const catalog = WIDGET_CATALOG.default_board.tiles;
  if (!markets) return catalog;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs).unref());
  const got = await Promise.race([markets(MARKETS.list, { query: { category: 'sports' } }).catch(() => null), timeout]);
  if (!got || fixtureOnly(got.markets, catalog)) return catalog;
  return weekBoard(got.markets, now) ?? catalog;
}

/** markets' fake lists only the made-up fixture markets the catalog's board already holds: that board is the right one. */
export function fixtureOnly(markets: Market[], catalog: DefaultTile[] = WIDGET_CATALOG.default_board.tiles): boolean {
  const named = new Set(catalog.flatMap((t) => (t.kind === 'display' ? t.market_ids : t.kind === 'folder' ? t.children.flatMap((c) => c.market_ids) : [])));
  return markets.length > 0 && markets.every((m) => named.has(m.market_id));
}
