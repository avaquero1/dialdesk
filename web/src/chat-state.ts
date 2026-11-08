/**
 * The chat's message state, with no DOM: what the log shows, what is waiting, and the plain words for errors and
 * limits (design.md section 11: what happened and what to do, never a code). chat.ts renders it.
 *
 * Replies arrive whole, after the safety check (ChatReply is never streamed). The agent's words are shown as they
 * come: this file never writes or reformats a number in them.
 */
import { LookPatch, type ChatTurn, type Look, type ToolChip } from '@app/contracts';

/** The first visit's opener. The browser sends it once, unseen, so the agent's greeting and its picks come first. */
export const OPENER = 'Hi';

/** A turn as edge sends it. `picks` (leagues, then teams, written by code) come on the live turn only: history may lack them. */
export type Turn = ChatTurn;

export interface Line {
  id: string;
  role: 'user' | 'agent' | 'error';
  text: string;
  chips: ToolChip[];
  picks: string[];
}

export interface ChatState {
  conversationId: string | null;
  lines: Line[];
  /** The message on its way: the agent is working (the shimmer shows). */
  pending: string | null;
  /** What the user did with each proposal chip, by proposal id. */
  decided: Record<string, Decision>;
  /** The line whose look change [Undo] can take back now: only the latest one, and only in this page. */
  undoLine: string | null;
  /** Look changes taken back. */
  undone: string[];
}

/**
 * A proposal chip after a tap: on its way (busy), added, not now, failed (the buttons stay, to try again), or gone
 * (decided before this page loaded, or no longer pending: it shows as a plain label).
 */
export type Decision = 'busy' | 'accepted' | 'rejected' | 'failed' | 'gone';

export const emptyChat = (): ChatState => ({ conversationId: null, lines: [], pending: null, decided: {}, undoLine: null, undone: [] });

const lineOf = (t: Turn): Line => ({
  id: t.turn_id,
  role: t.role,
  text: t.text,
  chips: t.role === 'agent' ? t.chips : [],
  picks: t.role === 'agent' ? (t.picks ?? []).filter((p) => typeof p === 'string' && p.trim()).slice(0, 12) : [],
});

/** The opener is never shown: the conversation starts with the agent's greeting. */
const hidden = (t: Turn, i: number) => i === 0 && t.role === 'user' && t.text === OPENER;

/** A conversation read back from edge (the chat reloads with the board). */
export function fromHistory(conversationId: string, turns: Turn[], pending?: ReadonlySet<string>): ChatState {
  const lines = turns.filter((t, i) => !hidden(t, i)).map(lineOf);
  // A proposal the board no longer holds as pending was decided before this page: no buttons on it.
  const decided: Record<string, Decision> = {};
  if (pending) for (const l of lines) for (const c of l.chips) if (c.status === 'proposed' && c.proposal_id && !pending.has(c.proposal_id)) decided[c.proposal_id] = 'gone';
  return { ...emptyChat(), conversationId, lines, decided };
}

/** The user's line goes out. `shown` is false for the opener. Old error lines go: the new try replaces them. */
export function send(s: ChatState, text: string, shown = true): ChatState {
  const lines = s.lines.filter((l) => l.role !== 'error');
  if (shown) lines.push({ id: `local-${lines.length}-${Date.now()}`, role: 'user', text, chips: [], picks: [] });
  return { ...s, lines, pending: text };
}

/** The guarded reply arrived whole. */
export function receive(s: ChatState, conversationId: string, turn: Turn): ChatState {
  const line = lineOf(turn);
  const look = line.chips.some((c) => c.tool === 'set_look' && c.status === 'applied');
  return { ...s, conversationId, lines: [...s.lines, line], pending: null, undoLine: look ? line.id : s.undoLine };
}

/** The look change a live reply applies now (history never re-applies one: it was saved when it happened). */
export function lookChange(turn: Turn): Partial<Look> | null {
  if (turn.role !== 'agent') return null;
  const c = turn.chips.find((x) => x.tool === 'set_look' && x.status === 'applied');
  if (!c) return null;
  const p = LookPatch.safeParse(c.args);
  return p.success && Object.keys(p.data).length ? (p.data as Partial<Look>) : null;
}

export const decide = (s: ChatState, proposalId: string, d: Decision): ChatState => ({ ...s, decided: { ...s.decided, [proposalId]: d } });

/** Undo was tapped: that change is taken back, and nothing older can be undone from here. */
export const undoLook = (s: ChatState): ChatState => (s.undoLine ? { ...s, undone: [...s.undone, s.undoLine], undoLine: null } : s);

/** How one chip shows: a question with two buttons, what the tap did, the look change with [Undo], or a label. */
export type ChipView =
  | { kind: 'ask'; proposalId: string; ask: string; yes: string; busy: boolean; failed: boolean }
  | { kind: 'said'; text: string }
  | { kind: 'look'; text: string; undo: boolean }
  | { kind: 'label'; label: string; status: ToolChip['status'] };

const YES: Partial<Record<ToolChip['tool'], string>> = { propose_widget: 'Add', tune_widget: 'Change', remove_widget: 'Remove' };
const DONE: Partial<Record<ToolChip['tool'], (l: string) => string>> = {
  propose_widget: (l) => `Added '${l}'.`,
  tune_widget: () => 'Changed.',
  remove_widget: () => 'Removed.',
};

export function chipView(s: ChatState, line: Line, c: ToolChip): ChipView {
  const yes = YES[c.tool];
  if (c.status === 'proposed' && c.proposal_id && yes) {
    const d = s.decided[c.proposal_id];
    if (d === 'accepted') return { kind: 'said', text: DONE[c.tool]!(c.label) };
    if (d === 'rejected') return { kind: 'said', text: 'Not now.' };
    if (d === 'gone') return { kind: 'label', label: c.label, status: c.status };
    const ask = c.tool === 'propose_widget' ? `Add '${c.label}'?` : `${c.label}?`;
    return { kind: 'ask', proposalId: c.proposal_id, ask, yes, busy: d === 'busy', failed: d === 'failed' };
  }
  if (c.tool === 'set_look' && c.status === 'applied') {
    if (s.undone.includes(line.id)) return { kind: 'said', text: 'Undone: the look is back as it was.' };
    return { kind: 'look', text: c.label, undo: s.undoLine === line.id };
  }
  return { kind: 'label', label: c.label, status: c.status };
}

/** The turn failed: a plain line says what happened and what to do. The user's line stays (the input gets it back). */
export function fail(s: ChatState, err: { status: number; retryAfterS?: number | null; code?: string }): ChatState {
  const text = errorWords(err);
  return { ...s, lines: [...s.lines, { id: `error-${Date.now()}`, role: 'error', text, chips: [], picks: [] }], pending: null };
}

/** The picks to offer now: only under the last line, and only when it is the agent's and nothing is on its way. */
export function currentPicks(s: ChatState): string[] {
  const last = s.lines.at(-1);
  return !s.pending && last?.role === 'agent' ? last.picks : [];
}

/** The words for a failed turn. Status 0 is "the server can't be reached". */
export function errorWords(err: { status: number; retryAfterS?: number | null; code?: string }): string {
  switch (err.status) {
    case 0:
      return "You're offline. Your message wasn't sent. Try again when you're back.";
    case 429:
      return err.retryAfterS && err.retryAfterS > 90
        ? 'Slow down a little. Try again in a few minutes.'
        : 'Slow down a little. Try again in a minute.';
    case 413:
    case 400:
      return err.code === 'bad_conversation' ? 'That chat ended. Send it again to start a new one.' : 'That message is too long. Make it shorter and try again.';
    case 503:
    case 502:
    case 504:
      return 'Lots of research going on. Yours is next: try again in a moment.';
    default:
      return "Your agent couldn't answer just now. Try again in a moment.";
  }
}
