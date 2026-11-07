/**
 * NFL and NBA teams and how each exchange spells them. Checked against the live APIs on 2026-11-07:
 * Kalshi's game tickers (KXNFLGAME-26NOV08NYJKC-KC) and Polymarket's game slugs (nfl-nyj-kc-2026-11-08, /teams).
 * The two spell every team the same way except the NFL's Jaguars (JAC / jax) and Rams (LAR / la).
 *
 * `code` is ours: Kalshi's code in lower case. Event keys and the source catalog's team feeds use it.
 */
export type GameLeague = 'nfl' | 'nba';

export interface Team {
  league: GameLeague;
  code: string;
  kalshi: string;
  polymarket: string;
  /** "Kansas City Chiefs" */
  name: string;
  /** "Chiefs": the word feeds and headlines use. */
  nickname: string;
}

const NFL: [string, string, string][] = [
  ['ARI', 'Arizona', 'Cardinals'],
  ['ATL', 'Atlanta', 'Falcons'],
  ['BAL', 'Baltimore', 'Ravens'],
  ['BUF', 'Buffalo', 'Bills'],
  ['CAR', 'Carolina', 'Panthers'],
  ['CHI', 'Chicago', 'Bears'],
  ['CIN', 'Cincinnati', 'Bengals'],
  ['CLE', 'Cleveland', 'Browns'],
  ['DAL', 'Dallas', 'Cowboys'],
  ['DEN', 'Denver', 'Broncos'],
  ['DET', 'Detroit', 'Lions'],
  ['GB', 'Green Bay', 'Packers'],
  ['HOU', 'Houston', 'Texans'],
  ['IND', 'Indianapolis', 'Colts'],
  ['JAC', 'Jacksonville', 'Jaguars'],
  ['KC', 'Kansas City', 'Chiefs'],
  ['LV', 'Las Vegas', 'Raiders'],
  ['LAC', 'Los Angeles', 'Chargers'],
  ['LAR', 'Los Angeles', 'Rams'],
  ['MIA', 'Miami', 'Dolphins'],
  ['MIN', 'Minnesota', 'Vikings'],
  ['NE', 'New England', 'Patriots'],
  ['NO', 'New Orleans', 'Saints'],
  ['NYG', 'New York', 'Giants'],
  ['NYJ', 'New York', 'Jets'],
  ['PHI', 'Philadelphia', 'Eagles'],
  ['PIT', 'Pittsburgh', 'Steelers'],
  ['SF', 'San Francisco', '49ers'],
  ['SEA', 'Seattle', 'Seahawks'],
  ['TB', 'Tampa Bay', 'Buccaneers'],
  ['TEN', 'Tennessee', 'Titans'],
  ['WAS', 'Washington', 'Commanders'],
];
const NFL_POLYMARKET: Record<string, string> = { JAC: 'jax', LAR: 'la' };

const NBA: [string, string, string][] = [
  ['ATL', 'Atlanta', 'Hawks'],
  ['BOS', 'Boston', 'Celtics'],
  ['BKN', 'Brooklyn', 'Nets'],
  ['CHA', 'Charlotte', 'Hornets'],
  ['CHI', 'Chicago', 'Bulls'],
  ['CLE', 'Cleveland', 'Cavaliers'],
  ['DAL', 'Dallas', 'Mavericks'],
  ['DEN', 'Denver', 'Nuggets'],
  ['DET', 'Detroit', 'Pistons'],
  ['GSW', 'Golden State', 'Warriors'],
  ['HOU', 'Houston', 'Rockets'],
  ['IND', 'Indiana', 'Pacers'],
  ['LAC', 'Los Angeles', 'Clippers'],
  ['LAL', 'Los Angeles', 'Lakers'],
  ['MEM', 'Memphis', 'Grizzlies'],
  ['MIA', 'Miami', 'Heat'],
  ['MIL', 'Milwaukee', 'Bucks'],
  ['MIN', 'Minnesota', 'Timberwolves'],
  ['NOP', 'New Orleans', 'Pelicans'],
  ['NYK', 'New York', 'Knicks'],
  ['OKC', 'Oklahoma City', 'Thunder'],
  ['ORL', 'Orlando', 'Magic'],
  ['PHI', 'Philadelphia', '76ers'],
  ['PHX', 'Phoenix', 'Suns'],
  ['POR', 'Portland', 'Trail Blazers'],
  ['SAC', 'Sacramento', 'Kings'],
  ['SAS', 'San Antonio', 'Spurs'],
  ['TOR', 'Toronto', 'Raptors'],
  ['UTA', 'Utah', 'Jazz'],
  ['WAS', 'Washington', 'Wizards'],
];

const build = (league: GameLeague, rows: [string, string, string][], poly: Record<string, string> = {}): Team[] =>
  rows.map(([kalshi, city, nickname]) => ({
    league,
    code: kalshi.toLowerCase(),
    kalshi,
    polymarket: poly[kalshi] ?? kalshi.toLowerCase(),
    name: `${city} ${nickname}`,
    nickname,
  }));

export const TEAMS: Team[] = [...build('nfl', NFL, NFL_POLYMARKET), ...build('nba', NBA)];

export const teamByKalshi = (league: GameLeague, code: string) => TEAMS.find((t) => t.league === league && t.kalshi === code);
export const teamByPolymarket = (league: GameLeague, code: string) => TEAMS.find((t) => t.league === league && t.polymarket === code);
export const teamByCode = (league: GameLeague, code: string) => TEAMS.find((t) => t.league === league && t.code === code);

/** Kalshi's game series per league. */
export const GAME_SERIES: Record<GameLeague, string> = { nfl: 'KXNFLGAME', nba: 'KXNBAGAME' };
export const leagueOfSeries = (series: string): GameLeague | null =>
  (Object.entries(GAME_SERIES).find(([, s]) => s === series)?.[0] as GameLeague | undefined) ?? null;
