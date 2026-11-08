/**
 * The summarizer speaks plain words (A1.3.7). The backstop on the template, and the real summarizer's answers, recorded
 * with scripts/summary-words-proof.ts (no key in the file) and counted again by today's code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANNED_WORDS, SUMMARIZER_PROMPT, jsonOf, plainTemplate } from '../src/run.ts';

describe('the backstop on a template', () => {
  it('"implied probability", in any case or written as the op, becomes chance', () => {
    expect(plainTemplate('Implied probability {n1}.')).toBe('Chance {n1}.');
    expect(plainTemplate('The IMPLIED  PROBABILITY is {n1}; implied_probability too.')).toBe('The Chance is {n1}; chance too.');
    expect(plainTemplate('Up {n1}. {q1}')).toBe('Up {n1}. {q1}');
  });

  it('a "points" typed after a number slot goes, because the slot already shows it; other points stay', () => {
    expect(plainTemplate('The line has moved {n2} points.')).toBe('The line has moved {n2}.');
    expect(plainTemplate('Moved {n2} point, then {n3}  POINTS.')).toBe('Moved {n2}, then {n3}.');
    expect(plainTemplate('The points of {q1} and {n1} pointers.')).toBe('The points of {q1} and {n1} pointers.');
  });

  it('a template that still holds a banned word is refused', () => {
    for (const t of ['The implied odds are {n1}.', 'Up {n1} pts.', 'The EV is {n1}.', 'A sandbox read it.', 'Two sandboxes.', 'The receipt says {n1}.', 'See receipts.'])
      expect(plainTemplate(t), t).toBeNull();
  });

  it('whole words only: every, event, level and accepts pass', () => {
    for (const t of ['Every level of the event is {n1}.', 'simplied', 'Accepts {n1}.']) expect(plainTemplate(t), t).toBe(t);
  });
});

type Answer = { rep: number; model: string; usd: number; content: string; banned: string | null };
const rec = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/summary-words-a1-3-7.json'), 'utf8')) as {
  spend: { cap_usd: number; spent_usd: number; stopped: string | null };
  held_banned_word: number;
  prompt: string;
  answers: (Answer | { rep: number; error: string })[];
};
const answered = rec.answers.filter((a): a is Answer => 'content' in a);
const template = (a: Answer) => (jsonOf(a.content) as { template: string }).template;

describe("the real summarizer's answers (recorded)", () => {
  it('ran under the cap, never stopped, every call answered, asked with the prompt that is in the code', () => {
    expect(rec.spend.cap_usd).toBeLessThanOrEqual(0.05);
    expect(rec.spend.spent_usd).toBeLessThan(rec.spend.cap_usd);
    expect(rec.spend.stopped).toBeNull();
    expect(answered).toHaveLength(6);
    expect(rec.prompt).toBe(SUMMARIZER_PROMPT);
  });

  it('today\'s code counts the same banned words, and none gets past the backstop', () => {
    const held = answered.filter((a) => BANNED_WORDS.test(template(a)));
    process.stdout.write(`[summary words] ${held.length} of ${answered.length} answers hold a banned word before the backstop\n`);
    expect(held.length).toBe(rec.held_banned_word);
    for (const a of answered) {
      expect(template(a).match(BANNED_WORDS)?.[0] ?? null, `rep ${a.rep}`).toBe(a.banned);
      const after = plainTemplate(template(a));
      expect(after, `rep ${a.rep}`).not.toBeNull();
      expect(after!, `rep ${a.rep}`).not.toMatch(BANNED_WORDS);
      expect(after!, `rep ${a.rep}`).not.toMatch(/\{n[0-9]{1,2}\}\s+points?/i);
    }
  });
});
