import { describe, expect, it } from 'vitest';
import { BLOCKED_CHAT_LINE, newId, type ToolChip } from '@app/contracts';
import { OPENER, currentPicks, emptyChat, errorWords, fail, fromHistory, receive, send, type Turn } from '../../src/chat-state.ts';

const at = new Date().toISOString();
const agent = (text: string, o: { picks?: string[]; chips?: ToolChip[] } = {}): Turn => ({
  turn_id: newId('trn'),
  role: 'agent',
  text,
  chips: o.chips ?? [],
  verdict_id: newId('vrd'),
  at,
  ...(o.picks && { picks: o.picks }),
});
const user = (text: string): Turn => ({ turn_id: newId('trn'), role: 'user', text, chips: [], verdict_id: null, at });
const cnv = newId('cnv');

describe('chat message state', () => {
  it('the first visit: the opener goes out unseen, the greeting comes back with the leagues to tap', () => {
    let s = send(emptyChat(), OPENER, false);
    expect(s.lines).toEqual([]);
    expect(s.pending).toBe(OPENER);
    expect(currentPicks(s)).toEqual([]);
    s = receive(s, cnv, agent('Hi. Which teams or markets do you follow?', { picks: ['NFL', 'NBA'] }));
    expect(s.conversationId).toBe(cnv);
    expect(s.pending).toBeNull();
    expect(s.lines.map((l) => [l.role, l.text])).toEqual([['agent', 'Hi. Which teams or markets do you follow?']]);
    expect(currentPicks(s)).toEqual(['NFL', 'NBA']);
  });

  it("a user's line shows at once; the picks wait while the agent works, then the new turn's picks replace them", () => {
    let s = receive(send(emptyChat(), OPENER, false), cnv, agent('Hi.', { picks: ['NFL', 'NBA'] }));
    s = send(s, 'NFL');
    expect(s.lines.at(-1)).toMatchObject({ role: 'user', text: 'NFL' });
    expect(currentPicks(s)).toEqual([]);
    s = receive(s, cnv, agent('Which team?', { picks: ['Bills', 'Chiefs'] }));
    expect(currentPicks(s)).toEqual(['Bills', 'Chiefs']);
    s = receive(send(s, 'Bills'), cnv, agent('I made two widgets. Add them?'));
    expect(currentPicks(s)).toEqual([]);
  });

  it('keeps the agent words exactly as they came (numbers too) and its tool chips', () => {
    const chip: ToolChip = { tool: 'set_look', args: { hue: 32 }, status: 'applied', proposal_id: null, label: 'set_look · hue 32°' };
    const text = 'The market says 61%, up 4 points since yesterday.';
    const s = receive(send(emptyChat(), 'warmer'), cnv, agent(text, { chips: [chip] }));
    expect(s.lines.at(-1)).toMatchObject({ role: 'agent', text, chips: [chip] });
  });

  it('a blocked reply is shown like any reply (the guard already replaced it)', () => {
    const s = receive(send(emptyChat(), 'advice-test'), cnv, agent(BLOCKED_CHAT_LINE));
    expect(s.lines.at(-1)!.text).toBe(BLOCKED_CHAT_LINE);
  });

  it('history: the opener is hidden, the rest comes back in order; user turns never carry picks', () => {
    const turns = [user(OPENER), agent('Hi.', { picks: ['NFL'] }), user('NFL'), agent('Which team?', { picks: ['Bills'] })];
    const s = fromHistory(cnv, turns);
    expect(s.lines.map((l) => l.text)).toEqual(['Hi.', 'NFL', 'Which team?']);
    expect(currentPicks(s)).toEqual(['Bills']);
    // "Hi" typed later is a real line
    expect(fromHistory(cnv, [...turns, user(OPENER)]).lines.at(-1)!.text).toBe(OPENER);
  });

  it('caps and cleans picks', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Team ${i}`);
    expect(currentPicks(receive(emptyChat(), cnv, agent('Pick', { picks: [...many, ' '] })))).toHaveLength(12);
  });

  it('a failed turn adds one plain line and clears the wait; the next try removes it', () => {
    let s = fail(send(emptyChat(), 'Bills'), { status: 429, retryAfterS: 30 });
    expect(s.pending).toBeNull();
    expect(s.lines.map((l) => l.role)).toEqual(['user', 'error']);
    expect(s.lines.at(-1)!.text).toBe('Slow down a little. Try again in a minute.');
    expect(currentPicks(s)).toEqual([]);
    s = send(s, 'Bills');
    expect(s.lines.map((l) => l.role)).toEqual(['user', 'user']);
  });

  it('error words: plain, what happened and what to do, never a code or a status number', () => {
    const cases = [
      { status: 0 },
      { status: 429, retryAfterS: 30 },
      { status: 429, retryAfterS: 600 },
      { status: 413 },
      { status: 400, code: 'bad_conversation' },
      { status: 400, code: 'invalid' },
      { status: 503 },
      { status: 500 },
      { status: -1 },
    ];
    const words = cases.map(errorWords);
    expect(words[0]).toMatch(/offline/);
    expect(words[1]).toBe('Slow down a little. Try again in a minute.');
    expect(words[2]).toMatch(/few minutes/);
    expect(words[4]).toMatch(/new one/);
    expect(words[6]).toMatch(/Lots of research going on/);
    for (const w of words) {
      expect(w).not.toMatch(/\d/);
      expect(w).not.toMatch(/error|bad_|invalid|status|http/i);
      expect(w).toMatch(/[.]$/);
    }
  });
});
