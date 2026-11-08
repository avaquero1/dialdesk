import type { Candidate, Market } from '@app/contracts';
import { toCandidates } from './candidates.ts';

/**
 * Our own poisoned test page for the containment demo, on the live link: off unless MARKETS_TESTPAGE_URL and
 * MARKETS_TESTPAGE_TEAM are both set. A market of that team's game gets the page first, beside two live candidates so the
 * planner reads it (with five candidates it once left ours out, C2.1 run 1). Every other game is untouched.
 */
const BESIDE_OURS = 2;

/** True when the event key (`nfl-2026-11-08-nyj-kc`) names the team. */
const playsIn = (eventKey: string | null | undefined, code: string) => !!eventKey && eventKey.split('-').slice(-2).includes(code);

export function withTestPage(list: Candidate[], market: Pick<Market, 'event_key'>, url: string, team: string, at: string): Candidate[] {
  if (!url || !team || !playsIn(market.event_key, team)) return list;
  const host = new URL(url).hostname;
  const [ours] = toCandidates([{ url, domain: host, published_at: at, via: 'search' }], [], new Set([host]));
  return [ours!, ...list.filter((c) => c.allowed).slice(0, BESIDE_OURS)];
}
