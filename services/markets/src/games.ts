import { GAME_SERIES, TEAMS, leagueOfSeries, teamByCode, teamByKalshi, teamByPolymarket, type GameLeague, type Team } from './teams.ts';

/**
 * One NFL or NBA game, and the names both exchanges give it. Both list the away team first and date the game in ET:
 *   event key (ours)   nfl-2026-11-08-nyj-kc
 *   Kalshi event       KXNFLGAME-26NOV08NYJKC, markets KXNFLGAME-26NOV08NYJKC-NYJ and -KC (YES = that team wins)
 *   Polymarket market  nfl-nyj-kc-2026-11-08, outcomes ["Jets", "Chiefs"] (YES = the first outcome, the away team)
 */
export interface Game {
  league: GameLeague;
  /** YYYY-MM-DD, the game's date in ET as both exchanges write it */
  date: string;
  away: Team;
  home: Team;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export const eventKeyOf = (g: Game) => `${g.league}-${g.date}-${g.away.code}-${g.home.code}`;
export const polymarketSlugOf = (g: Game, date = g.date) => `${g.league}-${g.away.polymarket}-${g.home.polymarket}-${date}`;

/**
 * Polymarket dates some slugs by the kickoff's UTC day: Sunday Night Football on Nov 8 ET is nfl-tb-chi-2026-11-09
 * (seen 2026-11-07; its NBA slugs use the ET day). So a game's slug is one of these two.
 */
export const polymarketSlugsOf = (g: Game) => [polymarketSlugOf(g), polymarketSlugOf(g, nextDay(g.date))];

export function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The ET calendar day of an instant, YYYY-MM-DD: the day both exchanges' tickers mean. */
export const etDate = (iso: string) => ET.format(new Date(iso));
export function kalshiEventOf(g: Game): string {
  const [y, m, d] = g.date.split('-');
  return `${GAME_SERIES[g.league]}-${y!.slice(2)}${MONTHS[Number(m) - 1]}${d}${g.away.kalshi}${g.home.kalshi}`;
}
export const titleOf = (g: Game) => `${g.away.nickname} at ${g.home.nickname}`;

export function parseEventKey(key: string): Game | null {
  const m = /^(nfl|nba)-(\d{4}-\d{2}-\d{2})-([a-z0-9]{2,4})-([a-z0-9]{2,4})$/.exec(key);
  if (!m) return null;
  const league = m[1] as GameLeague;
  const away = teamByCode(league, m[3]!);
  const home = teamByCode(league, m[4]!);
  return away && home && away !== home ? { league, date: m[2]!, away, home } : null;
}

/** KXNFLGAME-26NOV08NYJKC (an event) or KXNFLGAME-26NOV08NYJKC-KC (a market: also returns the YES team). */
export function parseKalshiTicker(ticker: string): (Game & { yes: Team | null }) | null {
  const m = /^([A-Z0-9]+)-(\d{2})([A-Z]{3})(\d{2})([A-Z]{4,8})(?:-([A-Z]{2,4}))?$/.exec(ticker);
  if (!m) return null;
  const league = leagueOfSeries(m[1]!);
  const month = MONTHS.indexOf(m[3]!);
  if (!league || month < 0) return null;
  const pair = m[5]!;
  const splits = TEAMS.filter((t) => t.league === league && pair.startsWith(t.kalshi))
    .map((away) => ({ away, home: teamByKalshi(league, pair.slice(away.kalshi.length)) }))
    .filter((s): s is { away: Team; home: Team } => !!s.home && s.home !== s.away);
  if (splits.length !== 1) return null;
  const { away, home } = splits[0]!;
  const yes = m[6] ? (m[6] === away.kalshi ? away : m[6] === home.kalshi ? home : undefined) : null;
  if (yes === undefined) return null;
  return { league, date: `20${m[2]}-${String(month + 1).padStart(2, '0')}-${m[4]}`, away, home, yes };
}

/** nfl-nyj-kc-2026-11-08: a game's moneyline market. Other slugs (spreads, props, futures) answer null. */
export function parsePolymarketSlug(slug: string): Game | null {
  const m = /^(nfl|nba)-([a-z]{2,4})-([a-z]{2,4})-(\d{4}-\d{2}-\d{2})$/.exec(slug);
  if (!m) return null;
  const league = m[1] as GameLeague;
  const away = teamByPolymarket(league, m[2]!);
  const home = teamByPolymarket(league, m[3]!);
  return away && home && away !== home ? { league, date: m[4]!, away, home } : null;
}
