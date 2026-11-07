/**
 * Q6 and F7: the agent may answer market questions, but only with markets quotes and board receipts, never its own
 * numbers. A tool that reads a number (quote_market, read_receipt) gives the model a slot name and what it means,
 * never the value. The model writes `{n1}`; code fills it after the loop. A digit the model typed itself, outside a
 * slot, blocks the reply (unless it is the user's own number or part of a name it was shown, like "Week 10").
 */
import type { EngineReceipt, Market } from '@app/contracts';

export const SLOT_RE = /\{n([0-9]{1,2})\}/g;
const DIGITS_RE = /[0-9]+(?:[.,][0-9]+)?/g;

export interface SlotValue {
  /** What the value says, as the user reads it ("61%", "up 4 points"). Code writes it, never the model. */
  text: string;
  /** Where it came from: a market id or a receipt id. */
  source: string;
}

const pct = (p: number) => `${Math.round(p * 1000) / 10}%`;
const pts = (n: number) => {
  const r = Math.round(Math.abs(n) * 10) / 10;
  return `${r} point${r === 1 ? '' : 's'}`;
};
const move = (n: number) => (n === 0 ? 'unchanged' : `${n > 0 ? 'up' : 'down'} ${pts(n)}`);

/** One turn's numbers. Slot names are given out in order: n1, n2… */
export class Slots {
  private values = new Map<string, SlotValue>();

  private add(v: SlotValue): string {
    const name = `n${this.values.size + 1}`;
    this.values.set(name, v);
    return name;
  }

  /** quote_market: the YES price as an implied probability, and the one-day move. Values stay here. Meanings hold no digit (the model copies them). */
  quote(m: Market): Record<string, unknown> {
    const slots: Record<string, string> = {};
    slots[this.add({ text: pct(m.yes_price_cents / 100), source: m.market_id })] = 'implied probability of YES, from the last traded price';
    if (m.previous_price_cents !== null)
      slots[this.add({ text: move(m.yes_price_cents - m.previous_price_cents), source: m.market_id })] =
        'the move since yesterday, written with its direction (e.g. "up N points" or "unchanged")';
    return { market_id: m.market_id, exchange: m.exchange, stale: m.stale, slots };
  }

  /** read_receipt: the engine's value in its unit. The model gets the op and formula (code-written), not the value. */
  receipt(r: EngineReceipt): Record<string, unknown> {
    const name = this.add({ text: formatValue(r.op, r.unit, r.value), source: r.id });
    return { receipt_id: r.id, op: r.op, unit: r.unit, formula: r.formula.slice(0, 120), slots: { [name]: `the ${r.op} value` } };
  }

  has(name: string) {
    return this.values.has(name);
  }

  /** The model's template with every slot filled. `missing` lists slots the turn never handed out. */
  fill(template: string): { text: string; missing: string[]; used: SlotValue[] } {
    const missing: string[] = [];
    const used: SlotValue[] = [];
    const text = template.replace(SLOT_RE, (whole, n: string) => {
      const v = this.values.get(`n${n}`);
      if (!v) {
        missing.push(`n${n}`);
        return whole;
      }
      used.push(v);
      return v.text;
    });
    return { text, missing, used };
  }
}

export function formatValue(op: string, unit: EngineReceipt['unit'], v: number): string {
  switch (unit) {
    case 'probability':
      return pct(v);
    case 'points':
      return op === 'movement' ? move(v) : pts(v);
    case 'cents':
      return `${Math.round(v * 10) / 10}¢`;
    case 'dollars':
      return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
    case 'decimal_odds':
      return v.toFixed(2);
    default:
      return String(Math.round(v * 1000) / 1000);
  }
}

/** Every number written in these texts, as the user or a name shows it. */
export function digitsIn(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(DIGITS_RE)) out.add(m[0]);
  return out;
}

/** Numbers the model typed outside a slot that nobody gave it. Empty = clean. */
export function strayDigits(modelText: string, allowed: Set<string>): string[] {
  const outside = modelText.replace(SLOT_RE, ' ');
  return [...outside.matchAll(DIGITS_RE)].map((m) => m[0]).filter((d) => !allowed.has(d));
}

/** The history the model reads back: its own past templates, slots shown as words, so it never re-reads a value. */
export const forHistory = (template: string) => template.replace(SLOT_RE, '(a number from a tool)');
