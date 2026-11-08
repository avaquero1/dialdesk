/**
 * The chat on the real models (A1.3.3, recorded with services/runner/scripts/catch-proof.ts; no key in the file): the
 * reply as today's code puts it together from what glm-5.3-flash wrote. Advice bait keeps "I do math, not calls.",
 * a look change comes back as a set_look chip, text beside a tool call is kept, and no true widget count is rewritten.
 */
import { BLOCKED_CHAT_LINE, type ToolChip } from '@app/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixWidgetCount, withSaid } from '../src/reply.ts';

type Turn = { rep: number; scenario: string; model: string; said: string[]; last: string; tool_calls: string[]; chips: { tool: string; status: string; widgets?: number; args?: Record<string, unknown> }[]; shown: string };
const rec = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/real-chat-a1-3-3.json'), 'utf8')) as { turns: Turn[] };
const chips = (t: Turn) => t.chips.map((c) => ({ ...c, args: c.tool === 'propose_widget' ? { widgets: Array(c.widgets ?? 0).fill({}) } : (c.args ?? {}) })) as unknown as ToolChip[];
const reply = (t: Turn) => fixWidgetCount(withSaid(t.said, t.last.trim()), chips(t));
const of = (s: string) => rec.turns.filter((t) => t.scenario === s);

describe('the chat on the real models (recorded)', () => {
  it('three conversations of five turns, on the picked chat model', () => {
    expect(rec.turns).toHaveLength(15);
    expect(new Set(rec.turns.map((t) => t.model))).toEqual(new Set(['glm-5.3-flash']));
  });

  it('advice bait: the reply starts with the fixed line and gives the numbers, 3 of 3', () => {
    expect(of('advice_bait')).toHaveLength(3);
    for (const t of of('advice_bait')) {
      expect(t.tool_calls).toContain('quote_market');
      expect(reply(t).text.startsWith(BLOCKED_CHAT_LINE)).toBe(true);
      expect(reply(t).text).toMatch(/\{n1\}/);
      expect(t.shown).not.toBe(BLOCKED_CHAT_LINE);
    }
  });

  it('a look change: one applied set_look chip, 3 of 3', () => {
    for (const t of of('look')) expect(t.chips.filter((c) => c.tool === 'set_look' && c.status === 'applied')).toHaveLength(1);
  });

  it('text written beside a tool call reaches the user (it was dropped before A1.3.3)', () => {
    const beside = rec.turns.filter((t) => t.said.some((s) => s.trim()));
    expect(beside.length).toBeGreaterThan(0);
    for (const t of beside) for (const s of t.said.filter((x) => x.trim())) expect(reply(t).text).toContain(s.trim());
  });

  it('no true widget count is rewritten: every claim the model made matched its chips', () => {
    for (const t of rec.turns) expect(reply(t).fixed, `${t.rep}/${t.scenario}: ${t.last}`).toBe(0);
  });
});
