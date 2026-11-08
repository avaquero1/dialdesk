/** The reply put together by code: text beside a tool call is kept, and a widget count past the chips is rewritten. */
import type { ToolChip } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { claimedCount, fixWidgetCount, proposedCount, withSaid } from '../src/reply.ts';

const chip = (n: number, status: ToolChip['status'] = 'proposed'): ToolChip =>
  ({ tool: 'propose_widget', args: { widgets: Array.from({ length: n }, (_, i) => ({ title: `w${i}` })) }, label: 'w', status, proposal_id: null }) as ToolChip;
const look = { tool: 'set_look', args: { theme: 'glass' }, label: 'set_look', status: 'applied', proposal_id: null } as unknown as ToolChip;

describe('withSaid', () => {
  it('keeps the line written beside a tool call, before the last reply', () => {
    expect(withSaid(['I do math, not calls.'], 'The Chiefs are at {n1}.')).toBe('I do math, not calls. The Chiefs are at {n1}.');
  });
  it("doesn't repeat a line the last reply already holds, or an empty one", () => {
    expect(withSaid(['I do math, not calls.', '  '], 'I do math, not calls. The Chiefs are at {n1}.')).toBe('I do math, not calls. The Chiefs are at {n1}.');
    expect(withSaid(['Checking.', 'Checking.'], 'Done.')).toBe('Checking. Done.');
  });
  it('with no last reply, the said text is the reply', () => {
    expect(withSaid(['I do math, not calls.'], '')).toBe('I do math, not calls.');
    expect(withSaid([], '')).toBe('');
  });
});

describe('fixWidgetCount', () => {
  it('counts proposed widgets, not refused chips or other tools', () => {
    expect(proposedCount([chip(2), chip(1, 'refused'), look])).toBe(2);
  });
  it('reads the claimed count, and ignores offers and questions', () => {
    expect(claimedCount('I proposed two widgets for Sunday.')).toBe(2);
    expect(claimedCount('I added a couple of new widgets.')).toBe(2);
    expect(claimedCount("Here's a probability widget.")).toBe(1);
    expect(claimedCount('Here are your widgets.')).toBe(2);
    // glm-5.3-flash's own words in the A1.3.3 runs.
    expect(claimedCount('I proposed three Chiefs tiles: news, a movement tracker, and a Kalshi-Polymarket gap.')).toBe(3);
    expect(claimedCount("I proposed an NFL Week 10 events widget with this week's games.")).toBeNull();
    expect(claimedCount('I proposed the Week 10 widgets.')).toBe(2);
    expect(claimedCount('Want two widgets for this game?')).toBeNull();
    expect(claimedCount('I can add three widgets if you like.')).toBeNull();
    expect(claimedCount('The Chiefs are at {n1}.')).toBeNull();
  });
  it('"I proposed two widgets" beside one chip is rewritten from the chips', () => {
    const r = fixWidgetCount('I proposed two widgets for Chiefs at Bills. Tap to add them.', [chip(1)]);
    expect(r).toEqual({ text: 'I proposed one widget: tap it to add it. Tap to add them.', fixed: 1 });
  });
  it('a claim with no chip at all, and a plural beside one chip, are caught', () => {
    expect(fixWidgetCount('I added a widget for the Bills.', []).text).toBe('No widget was proposed this time.');
    expect(fixWidgetCount('Here are your widgets.', [chip(1)]).fixed).toBe(1);
  });
  it('a true count, or fewer than the chips, is left alone', () => {
    for (const [t, chips] of [
      ['I proposed two widgets.', [chip(2)]],
      ['I proposed two widgets.', [chip(1), chip(1)]],
      ["Here's a widget for the Bills.", [chip(2)]],
      ['Here are your widgets.', [chip(3)]],
      ['Your board has six widgets now? Not quite.', [chip(1)]],
    ] as const)
      expect(fixWidgetCount(t, [...chips]), t).toEqual({ text: t, fixed: 0 });
  });
  it('several wrong sentences become one true line', () => {
    expect(fixWidgetCount('I built three widgets. I added three widgets.', [chip(2)]).text).toBe('I proposed two widgets: tap each one to add it.');
  });
});
