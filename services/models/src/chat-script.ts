/**
 * The fake chat model: multi-step turns, scripted. Each call plays one step. It reads the last user message, the
 * markets the agent listed in its <data> block, and the tool results already in this turn (everything after the last
 * user message), so a turn goes the way it would with a real model: tool call, tool call, then words.
 * - Nothing named yet: "Hi. Which teams or markets do you follow?" (the agent adds the league and team picks).
 * - A league: asks which of its teams.
 * - A team: propose_widget for its next game's news, then for its price move, then "Tap to add them."
 * - Advice bait ("should I buy"): quote_market, then "I do math, not calls." with the quote's slots.
 * - "warmer" / "cooler": set_look with a hue, then "Done: warmer glass."
 * - "advice-test": advice wording, which the guard must block.
 * Every reply uses only slot names the tools handed out, and types no digit.
 */
import type { CompleteBody, Completion } from '@app/contracts';

type Msg = CompleteBody['messages'][number];
type Out = Pick<Completion, 'content' | 'tool_calls'>;

export interface ScriptEvent {
  event_key: string;
  title: string;
  /** Away team, then home team, as the exchange title names them. */
  teams: [string, string];
  market_ids: string[];
}

const LEAGUES = ['nfl', 'nba', 'mlb', 'nhl', 'ncaaf', 'ncaab', 'soccer'];
/** "Chiefs at Bills: Chiefs win", "Chiefs at Bills Winner?", "Chiefs vs. Bills": away team, then home team. */
const TEAMS_RE = /^([^:]+?)\s+(?:at|vs\.?|@)\s+([^:?]+?)\s*(?::.*|winner\?)?$/i;

/** ["Chiefs", "Bills"]; null when the title isn't one game. */
export function teamsOf(title: string): [string, string] | null {
  const m = TEAMS_RE.exec(title.trim());
  return m ? [m[1]!.trim(), m[2]!.trim()] : null;
}

/** The markets lines of the agent's <data> block, grouped by event. */
export function eventsInData(system: string): ScriptEvent[] {
  const start = system.indexOf('Markets (id · title · event key):');
  if (start < 0) return [];
  const byKey = new Map<string, ScriptEvent>();
  for (const line of system.slice(start).split('\n').slice(1)) {
    const m = /^- (\S+) · (.+?)(?: · (\S+))?$/.exec(line.trim());
    if (!m) break;
    const [, id, title, key] = m;
    const teams = teamsOf(title!);
    if (!key || !teams) continue;
    const e = byKey.get(key) ?? { event_key: key, title: `${teams[0]} at ${teams[1]}`, teams, market_ids: [] };
    e.market_ids.push(id!);
    byKey.set(key, e);
  }
  return [...byKey.values()];
}

const named = (text: string, word: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text);

/** The first event the message names, and the team: the one named last when it names both. */
export function namedTeam(text: string, events: ScriptEvent[]): { event: ScriptEvent; team: string } | null {
  for (const event of events) {
    const hits = event.teams.filter((t) => named(text, t));
    if (hits.length) {
      const team = hits.sort((a, b) => text.toLowerCase().lastIndexOf(a.toLowerCase()) - text.toLowerCase().lastIndexOf(b.toLowerCase())).at(-1)!;
      return { event, team };
    }
  }
  return null;
}

const parse = (s: string): Record<string, unknown> => {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const say = (content: string): Out => ({ content, tool_calls: [] });
const call = (name: string, args: Record<string, unknown>, content = ''): Out => ({ content, tool_calls: [{ name, arguments: args }] });

export function chatStep(b: CompleteBody): Out {
  const msgs = b.messages;
  const lastUser = msgs.findLastIndex((m) => m.role === 'user');
  const said = msgs[lastUser]?.content ?? '';
  const text = said.toLowerCase();
  /** This turn's tool results so far, in order. */
  const done = msgs
    .slice(lastUser + 1)
    .filter((m): m is Msg & { tool_name: string } => m.role === 'tool' && !!m.tool_name)
    .map((m) => ({ name: m.tool_name, result: parse(m.content) }));
  const ok = done.filter((d) => d.result.ok === true);
  const events = eventsInData(msgs.find((m) => m.role === 'system')?.content ?? '');

  if (text.includes('advice-test')) return say('You should buy YES on the Chiefs. It is a sure thing.');

  if (/warmer|cooler/.test(text)) {
    const warm = text.includes('warmer');
    if (!done.length) return call('set_look', { hue: warm ? 32 : 210 });
    return say(ok.length ? `Done: ${warm ? 'warmer' : 'cooler'} glass.` : "I couldn't change the look.");
  }

  const hit = namedTeam(said, events);

  if (/\bshould i\b|\bbuy\b|\bsell\b/.test(text)) {
    const market_id = (hit?.event ?? events[0])?.market_ids[0];
    if (!market_id) return say('I do math, not calls. Tell me which game, and I can show its market.');
    if (!done.length) return call('quote_market', { market_id });
    const slots = Object.keys((ok[0]?.result.slots as Record<string, string> | undefined) ?? {});
    if (!slots.length) return say("I do math, not calls. I can't read that market's price right now.");
    const move = slots[1] ? `, {${slots[1]}} since yesterday` : '';
    return say(`I do math, not calls. The market says {${slots[0]}}${move}. Want a widget for this game?`);
  }

  if (hit) {
    const { event, team } = hit;
    const proposed = done.filter((d) => d.name === 'propose_widget');
    if (proposed.length === 0)
      return call(
        'propose_widget',
        { widgets: [{ kind: 'display', type: 'news', title: `${event.title} news`, market_ids: event.market_ids, params: { team, event_keys: [event.event_key] } }] },
        `Building your ${team} board.`,
      );
    if (proposed.length === 1)
      return call('propose_widget', {
        widgets: [{ kind: 'display', type: 'movement', title: `${event.title} move`, market_ids: event.market_ids.slice(0, 1), params: { event_keys: [event.event_key] } }],
      });
    const added = proposed.filter((d) => d.result.ok === true).length;
    if (!added) return say("I couldn't build those widgets. Try another team.");
    return say(added > 1 ? `The ${team} news and the price move for ${event.title}. Tap to add them.` : `A widget for ${event.title}. Tap to add it.`);
  }

  const league = LEAGUES.find((l) => named(text, l));
  if (league) return say(`Which ${league === 'soccer' ? 'soccer' : league.toUpperCase()} teams do you follow?`);
  if (done.length) return say('Done.');
  return say('Hi. Which teams or markets do you follow?');
}
