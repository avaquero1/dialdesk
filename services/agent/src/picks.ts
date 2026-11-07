/**
 * The first visit (design.md section 7): "Which teams or markets do you follow?" with tap-to-pick chips, leagues first,
 * then that league's teams. The picks are written by code from markets' public listing, never by the model, and a
 * tap sends the pick's text as the next message.
 */
import type { Market } from '@app/contracts';
import { cleanTitle } from './prompt.ts';

export const MAX_PICKS = 12;
const LEAGUE_NAMES: Record<string, string> = { nfl: 'NFL', nba: 'NBA', mlb: 'MLB', nhl: 'NHL', ncaaf: 'College football', ncaab: 'College basketball', soccer: 'Soccer' };
/** "Chiefs at Bills: Chiefs win", "Chiefs at Bills Winner?", "Chiefs vs. Bills": away team, then home team. */
const TEAMS_RE = /^([^:]+?)\s+(?:at|vs\.?|@)\s+([^:?]+?)\s*(?::.*|winner\?)?$/i;

/** Teams by league, from the exchange titles of one game ("Chiefs at Bills Winner?"). */
export function teamsByLeague(markets: Market[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const m of markets) {
    if (!m.league) continue;
    const set = out.get(m.league) ?? new Set<string>();
    out.set(m.league, set);
    const t = TEAMS_RE.exec(m.title.trim());
    for (const team of t ? [t[1]!, t[2]!] : []) {
      const clean = cleanTitle(team);
      if (clean && clean.length <= 40) set.add(clean);
    }
  }
  return new Map([...out].map(([l, s]) => [l, [...s].sort()]));
}

const says = (text: string, word: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text);

/**
 * The picks under an agent reply, or undefined. None in a Tune chat or when the turn proposed something. A league
 * just named gets its teams; a conversation that hasn't named a team yet gets the leagues.
 */
export function picksFor(o: { message: string; userTexts: string[]; markets: Market[]; tune: boolean; chips: number }): string[] | undefined {
  if (o.tune || o.chips) return undefined;
  const teams = teamsByLeague(o.markets);
  const allTeams = [...teams.values()].flat();
  if (allTeams.some((t) => says(o.message, t))) return undefined;
  const league = [...teams.keys()].find((l) => says(o.message, l) || says(o.message, LEAGUE_NAMES[l] ?? l));
  if (league) return teams.get(league)!.slice(0, MAX_PICKS);
  if (o.userTexts.some((u) => allTeams.some((t) => says(u, t)))) return undefined;
  const leagues = [...teams.keys()].map((l) => LEAGUE_NAMES[l] ?? l);
  return leagues.length ? leagues.slice(0, MAX_PICKS) : undefined;
}
