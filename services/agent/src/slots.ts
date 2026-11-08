/**
 * Q6 and F7: the agent may answer market questions, but only with markets quotes and board receipts, never its own
 * numbers. A tool that reads a number (quote_market, read_receipt) gives the model a slot name and what it means,
 * never the value. The model writes `{n1}`; code fills it after the loop. A digit the model typed itself, outside a
 * slot, blocks the reply (unless it is the user's own number or part of a name it was shown, like "Week 10").
 */
import type { EngineReceipt, Market, WidgetResult } from '@app/contracts';

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
/** In whole points, as the card shows a move, so the two read the same. */
const move = (n: number) => {
  const r = Math.round(n);
  return r === 0 ? 'unchanged' : `${r > 0 ? 'up' : 'down'} ${pts(r)}`;
};

const DAY_S = 86400;

/** A card's move since yesterday: the engine's number, from the price history, and its receipt. */
export interface BoardMove {
  value: number;
  receipt_id: string;
}

/**
 * "Since yesterday" has one definition: the engine's 24 h movement on the board's own results, by market id (the
 * newest result when two cards show the game). The exchanges' previous_price_cents is a different figure and can have
 * the opposite sign, so it is never worded as a move.
 */
export function boardMoves(results: (WidgetResult | null)[]): Map<string, BoardMove> {
  const out = new Map<string, BoardMove>();
  const newest = results.filter((r): r is WidgetResult => r !== null).sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const r of newest)
    for (const n of r.numbers) {
      if (n.op !== 'movement') continue;
      const rec = r.receipts.find((x) => x.id === n.receipt_id);
      const market = rec?.provenance?.series?.source;
      if (rec?.args.window_s === DAY_S && market && !out.has(market)) out.set(market, { value: n.value, receipt_id: rec.id });
    }
  return out;
}

/** What a receipt's slot means, in the words the chat may repeat. No digit (the model copies them). */
const meaning = (op: string) =>
  op === 'implied_probability' ? 'the chance'
  : op === 'gap' ? 'how far apart the two prices are, already in points: write it followed by "apart"'
  : op === 'expected_value' ? "the average result at the user's own chance"
  : `the ${op.replace(/_/g, ' ')}`;

/** One turn's numbers. Slot names are given out in order: n1, n2… */
export class Slots {
  private values = new Map<string, SlotValue>();

  private add(v: SlotValue): string {
    const name = `n${this.values.size + 1}`;
    this.values.set(name, v);
    return name;
  }

  /** quote_market: the YES price as a chance, and the board's move since yesterday when a card has one. Values stay here. Meanings hold no digit (the model copies them). */
  quote(m: Market, day?: BoardMove): Record<string, unknown> {
    const slots: Record<string, string> = {};
    slots[this.add({ text: pct(m.yes_price_cents / 100), source: m.market_id })] = 'the chance of YES, from the last traded price';
    if (day)
      slots[this.add({ text: move(day.value), source: day.receipt_id })] =
        'the move since yesterday, written with its direction (e.g. "up N points" or "unchanged")';
    return { market_id: m.market_id, exchange: m.exchange, stale: m.stale, slots };
  }

  /** read_receipt: the engine's value in its unit. The model gets the op and unit, not the value, nor the formula (it holds digits the model could copy). */
  receipt(r: EngineReceipt): Record<string, unknown> {
    const name = this.add({ text: formatValue(r.op, r.unit, r.value), source: r.id });
    return { receipt_id: r.id, op: r.op, unit: r.unit, slots: { [name]: meaning(r.op) } };
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
