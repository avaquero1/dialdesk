import type { GamePairing } from '@app/contracts';
import { etDate, eventKeyOf, parseEventKey, parseKalshiTicker, parsePolymarketSlug } from './games.ts';
import { gameStart, type PolyMarketRaw } from './polymarket.ts';

const no = (reason: string): GamePairing => ({ paired: false, reason });
const same = (a: string | undefined, b: string) => a?.trim().toLowerCase() === b.toLowerCase();

/**
 * The same game on both exchanges, with YES meaning the away team wins on both:
 *   Kalshi      <event>-<AWAY>   KXNFLGAME-26NOV08CINATL-CIN (YES = the Bengals win)
 *   Polymarket  <slug>           nfl-cin-atl-2026-11-08, outcomes ["Bengals", "Falcons"] (YES = the first outcome)
 * Paired only when every name agrees: the event key, Kalshi's ticker and its YES team, Polymarket's slug, its kickoff's
 * ET day, and its outcomes in away-home order. Otherwise not paired, and the reason is in plain words for the user.
 * `kalshi` is the event's markets (any order); `poly` is the game's moneyline, or null when Polymarket has none.
 */
export function pairGame(eventKey: string, kalshi: readonly { ticker: string }[], poly: PolyMarketRaw | null): GamePairing {
  const g = parseEventKey(eventKey);
  if (!g) return no("We can't name this game on both exchanges.");
  const away = kalshi.filter((m) => {
    const t = parseKalshiTicker(m.ticker);
    return t !== null && eventKeyOf(t) === eventKey && t.yes === g.away;
  });
  if (away.length !== 1) return no(`Kalshi has no single market on the ${g.away.nickname} winning this game.`);
  if (!poly) return no('Polymarket has no market for this game.');
  const slug = parsePolymarketSlug(poly.slug);
  if (!slug || slug.league !== g.league || slug.away !== g.away || slug.home !== g.home) return no("Polymarket's market is for a different game.");
  // The slug may name the kickoff's UTC day (Sunday and Monday night games); the kickoff time settles the ET day.
  const start = gameStart(poly.gameStartTime);
  const day = start ? etDate(start) : slug.date;
  if (day !== g.date) return no('The two exchanges list this game on different days.');
  if (!same(poly.outcomes[0], g.away.nickname) || !same(poly.outcomes[1], g.home.nickname))
    return no("Polymarket names the teams in another order, so its YES may mean the other team wins.");
  return { paired: true, kalshi: `kalshi:${away[0]!.ticker}`, polymarket: `polymarket:${poly.slug}`, yes_means: `${g.away.nickname} win` };
}
