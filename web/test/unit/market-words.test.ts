/**
 * W1.5.2c: a market's "You think" line says the engine's distance from the market in the words of design.md section 3
 * and reads the "you think" from the engine's receipt; board refuses a since move that isn't a gap, so the strip's
 * numbers[0] is always a chance's move.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Widget, WidgetResult } from '@app/contracts';
import { checkSince } from '../../../services/board/src/logic.ts';

vi.stubGlobal('document', { documentElement: {} });
const W = await import('../../src/widgets.ts');
const { sinceWords } = await import('../../src/moment-state.ts');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const num = (op: string, value: number, unit: string, receipt_id: string) => ({ id: receipt_id, op, value, unit, receipt_id });
const receipt = (id: string, op: string, args: Record<string, unknown>, value: number, unit: string) => ({ id, op, op_id: id, args, value, unit, formula: '', engine_version: '1' });
const card = (ev: number | null, opts: { up?: number; used?: number } = {}): Widget => {
  const up = opts.up ?? 0.65;
  const numbers = [num('movement', 2, 'points', 'r-mv'), num('implied_probability', 0.61, 'probability', 'r-ip'), ...(ev == null ? [] : [num('expected_value', ev, 'cents', 'r-ev')])];
  const receipts = [receipt('r-mv', 'movement', {}, 2, 'points'), receipt('r-ip', 'implied_probability', { price_cents: 61 }, 0.61, 'probability'), ...(ev == null ? [] : [receipt('r-ev', 'expected_value', { price_cents: 61, probability: opts.used ?? up }, ev, 'cents')])];
  return {
    spec: { kind: 'display', type: 'probability', size: 'M', title: 'Chiefs beat the Bills', widget_id: 'w1', account_id: 'a1', market_ids: [], params: { user_probability: up }, place: { col: 0, row: 0 } },
    profile: null,
    state: 'normal',
    result: { numbers, receipts, facts: [], sources: [], blocked: [], notes: [] } as unknown as WidgetResult,
    previous: null,
    updated_at: new Date().toISOString(),
  } as unknown as Widget;
};
const ctx = { titles: new Map<string, string>(), events: new Map<string, string>() };
const line = (w: Widget) => text(/<span class="ev".*?<\/span>/.exec(W.displayHtml(w, ctx))?.[0] ?? '');
const said = (w: Widget) => /<span class="ev" role="img" aria-label="([^"]*)"/.exec(W.displayHtml(w, ctx))?.[1];

describe('W1.5.2c: "You think" in the design\'s words, from the engine\'s number', () => {
  it.each([
    [4, "You think 65%: that's 4 points above the market."],
    [1, "You think 65%: that's 1 point above the market."],
    [-3, "You think 65%: that's 3 points below the market."],
    [-1, "You think 65%: that's 1 point below the market."],
    [0, "You think 65%: that's the same as the market."],
    [0.4, "You think 65%: that's the same as the market."],
    [4.5, "You think 65%: that's 5 points above the market."],
    [-4.5, "You think 65%: that's 5 points below the market."],
  ])('an engine value of %d', (ev, words) => {
    expect(line(card(ev))).toBe(words);
  });

  it('reads aloud the same sentence, with the percent in words', () => {
    expect(said(card(4))).toBe('You think 65 percent: that&#39;s 4 points above the market.');
  });

  it('the "you think" is the one the engine used, from its receipt', () => {
    expect(line(card(4, { up: 0.7, used: 0.65 }))).toBe("You think 65%: that's 4 points above the market.");
  });

  it('no number from the engine yet: the plain line, nothing worked out in the page', () => {
    expect(line(card(null))).toBe('You think 65%. The math for it comes with the first run.');
  });

  it('the old wording is gone', () => {
    expect(W.displayHtml(card(4), ctx)).not.toMatch(/per contract|by the math/);
  });
});

describe('W1.5.2c: the strip\'s numbers[0] is a chance\'s move, whatever the plan puts first', () => {
  const since = (op: string) => ({
    since: {
      from_result_id: 'r0',
      numbers: [{ id: 'since_1', op, value: 3, unit: 'points', receipt_id: 'r1' }],
      receipts: [{ id: 'r1', value: 3 }],
    },
  });

  it('board refuses a since number that is a movement', () => {
    expect(() => checkSince(since('movement') as unknown as WidgetResult)).toThrow(/gap receipt/);
    expect(() => checkSince(since('gap') as unknown as WidgetResult)).not.toThrow();
  });

  it('the strip says that move', () => {
    expect(sinceWords({ from_result_id: 'r0', from_at: new Date().toISOString(), new_items: 0, receipts: [], numbers: [{ id: 'since_1', op: 'gap', value: 3, unit: 'points', receipt_id: 'r1' }] } as never)).toBe('Since you last looked: up 3 points');
  });
});
