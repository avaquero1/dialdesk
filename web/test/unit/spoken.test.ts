/** Numbers read in words for a screen reader (design.md section 12). */
import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('document', { documentElement: {} });
const W = await import('../../src/widgets.ts');

describe('spoken: what a screen reader says for a number', () => {
  it('reads percents, cents and signs as words', () => {
    expect(W.spoken('61%')).toBe('61 percent');
    expect(W.spoken('Kalshi 61¢')).toBe('Kalshi 61 cents');
    expect(W.spoken('worth 1¢')).toBe('worth 1 cent');
    expect(W.spoken('worth +3.5¢ per contract')).toBe('worth plus 3.5 cents per contract');
    expect(W.spoken('Balance −$5.00')).toBe('Balance minus $5.00');
  });
});

describe('leadNumber: what the How we got it row leads with', () => {
  const n = (op: string, id: string) => ({ op, id }) as never;
  const r = (numbers: never[]) => ({ numbers }) as never;
  it('picks the chance wherever it sits, else the first number, else nothing', () => {
    const move = n('movement', 'a');
    const chance = n('implied_probability', 'b');
    expect(W.leadNumber(r([move, chance]))).toBe(chance);
    expect(W.leadNumber(r([move, n('gap', 'c')]))).toBe(move);
    expect(W.leadNumber(r([]))).toBeUndefined();
  });
});
