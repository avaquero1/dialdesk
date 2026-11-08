/** "Since you last looked" in runner's plans (N1.2.1): the gap ops against the baseline, and their split from the widget's numbers. */
import { newId, type EngineResult, type WidgetResult } from '@app/contracts';
import { sampleResult } from '@app/testkit';
import { describe, expect, it } from 'vitest';
import { MAX_SINCE, sinceInputs, splitSince } from '../src/plans.ts';

const T0 = '2026-11-07T18:00:00Z';
const T1 = '2026-11-07T20:00:00Z';
function baseline(sources: string[]): WidgetResult {
  const r = sampleResult(newId('wid'), newId('acc'), 'pass').result as WidgetResult;
  const base = r.receipts[0]!;
  r.receipts = sources.map((source, i) => ({ ...base, id: `r-0000000${i}`, op_id: `n${i + 1}`, args: { price_cents: 50 + i }, provenance: { price_cents: { source, as_of: T0 } } }));
  return r;
}
const plan = (n: number) => ({ plan_version: 1, ops: Array.from({ length: n }, (_, i) => ({ id: `n${i + 1}`, op: 'implied_probability' as const, args: { price_cents: `price_${i + 1}` } })) });
const input = (sources: string[]) => ({
  numbers: Object.fromEntries(sources.map((_, i) => [`price_${i + 1}`, 60 + i])),
  provenance: Object.fromEntries(sources.map((source, i) => [`price_${i + 1}`, { source, as_of: T1 }])),
});

describe('since: the gap ops against the previous visit', () => {
  it('one gap per chance whose market the baseline priced, with the old price, its market and its time', () => {
    const sv = sinceInputs(baseline(['kalshi:A', 'kalshi:B']), plan(3), input(['kalshi:A', 'kalshi:C', 'kalshi:B']));
    expect(sv.ops).toEqual([
      { id: 'since_1', op: 'gap', args: { a_cents: 'since_from_1', b_cents: 'price_1' } },
      { id: 'since_2', op: 'gap', args: { a_cents: 'since_from_2', b_cents: 'price_3' } },
    ]);
    expect(sv.numbers).toEqual({ since_from_1: 50, since_from_2: 51 });
    expect(sv.origins).toEqual({ since_from_1: 'market', since_from_2: 'market' });
    expect(sv.provenance.since_from_2).toEqual({ source: 'kalshi:B', as_of: T0 });
  });
  it('nothing without a baseline; never more than MAX_SINCE; a market once', () => {
    expect(sinceInputs(null, plan(2), input(['kalshi:A', 'kalshi:B'])).ops).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => `kalshi:M${i}`);
    expect(sinceInputs(baseline(many), plan(20), input(many)).ops).toHaveLength(MAX_SINCE);
    expect(sinceInputs(baseline(['kalshi:A']), plan(2), input(['kalshi:A', 'kalshi:A'])).ops).toHaveLength(1);
  });
  it('splits the moves out of the engine result, receipts with them', () => {
    const num = (id: string, receipt_id: string) => ({ id, op: 'implied_probability' as const, unit: 'probability' as const, value: 0.6, receipt_id });
    const er = {
      ok: true, numbers: [num('n1', 'r-1'), { ...num('since_1', 'r-2'), op: 'gap' as const, unit: 'points' as const, value: 4 }],
      receipts: [{ id: 'r-1' }, { id: 'r-2' }], errors: [],
    } as unknown as EngineResult;
    const { er: rest, since } = splitSince(er, 'res_abcdefgh12');
    expect(rest.numbers.map((n) => n.id)).toEqual(['n1']);
    expect(rest.receipts.map((r) => r.id)).toEqual(['r-1']);
    expect(since).toMatchObject({ from_result_id: 'res_abcdefgh12', numbers: [{ id: 'since_1', value: 4 }], receipts: [{ id: 'r-2' }] });
    expect(splitSince({ ...er, numbers: [er.numbers[0]!] }, 'res_abcdefgh12').since).toBeNull();
  });
});
