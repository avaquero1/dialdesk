/**
 * The chat's message state, with no DOM: what the log shows, what is waiting, and the plain words for errors and
 * limits (design.md section 11: what happened and what to do, never a code). chat.ts renders it.
 *
 * Replies arrive whole, after the safety check (ChatReply is never streamed). The agent's words are shown as they
 * come: this file never writes or reformats a number in them.
 */
import type { ChatTurn, ToolChip } from '@app/contracts';

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
}

export const emptyChat = (): ChatState => ({ conversationId: null, lines: [], pending: null });

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
export function fromHistory(conversationId: string, turns: Turn[]): ChatState {
  return { conversationId, lines: turns.filter((t, i) => !hidden(t, i)).map(lineOf), pending: null };
}

/** The user's line goes out. `shown` is false for the opener. Old error lines go: the new try replaces them. */
export function send(s: ChatState, text: string, shown = true): ChatState {
  const lines = s.lines.filter((l) => l.role !== 'error');
  if (shown) lines.push({ id: `local-${lines.length}-${Date.now()}`, role: 'user', text, chips: [], picks: [] });
  return { ...s, lines, pending: text };
}

/** The guarded reply arrived whole. */
export function receive(s: ChatState, conversationId: string, turn: Turn): ChatState {
  return { conversationId, lines: [...s.lines, lineOf(turn)], pending: null };
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
