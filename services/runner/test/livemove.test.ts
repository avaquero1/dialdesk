/** A1.4.14: the series the engine reads ends at the live quote, so a card's move ends at the price on the card. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { EngineResult, MARKETS, type EngineInput, type WidgetSpec } from '@app/contracts';
import type { Call } from '@app/service-kit';
import { describe, expect, it } from 'vitest';
import { defaultPlan, marketNumbers, runnablePlan } from '../src/plans.ts';

type DisplaySpec = Extract<WidgetSpec, { kind: 'display' }>;
const ENGINE = join(import.meta.dirname, '../../../target/debug/engine');
const DAY = 86400;
const ID = 'kalshi:KXNFLGAME-26NOV08NYGPHI-NYG';
const AS_OF = '2026-11-08T20:35:00Z';
const NOW = Date.parse(AS_OF) / 1000;
const spec = { kind: 'display', type: 'movement', title: 'Giants at Eagles move', size: 'M', market_ids: [ID], params: { window_s: DAY }, sources: [] } as unknown as DisplaySpec;

/** markets, with one live quote and the (older, cached) candles. */
const stub = (price: number, points: { t: number; price_cents: number }[]) =>
  (async (ep: unknown) => {
    if (ep === MARKETS.get) return { market_id: ID, yes_price_cents: price, as_of: AS_OF, stale: false };
    if (ep === MARKETS.history) return { market_id: ID, points, as_of: '2026-11-08T20:31:00Z' };
    throw new Error('unexpected endpoint');
  }) as unknown as Call;

async function run(price: number, points: { t: number; price_cents: number }[]) {
  const plan = defaultPlan(spec);
  const mn = await marketNumbers(stub(price, points), spec, plan);
  const input: EngineInput = { plan: runnablePlan(plan, mn.numbers), numbers: mn.numbers, origins: mn.origins, ...(mn.provenance ? { provenance: mn.provenance } : {}) };
  const r = spawnSync(ENGINE, [], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 << 20 });
  expect(r.status, r.stderr).toBe(0);
  return { mn, er: EngineResult.parse(JSON.parse(r.stdout)) };
}
const series = (x: { numbers: Record<string, unknown> }) => x.numbers.series_1 as { t: number; v: number }[];

/** A day of candles that ends well below the live price: the shape Dana saw (the line ended at 46, the card said 88). */
const CANDLES = [
  { t: NOW - 2 * DAY, price_cents: 54 },
  { t: NOW - DAY + 600, price_cents: 62 },
  { t: NOW - 7200, price_cents: 63 },
  { t: NOW - 3600, price_cents: 46 },
];

describe('the move ends at the live price (A1.4.14)', () => {
  it('a quote far above the last candle: the move agrees in sign and size with the live price against a day ago', async () => {
    const { mn, er } = await run(88, CANDLES);
    expect(series(mn).at(-1)).toEqual({ t: NOW, v: 88 });
    const move = er.numbers.find((n) => n.op === 'movement')!;
    expect(move.value).toBe(88 - 62);
    const line = er.numbers.filter((n) => n.op === 'price_at');
    expect(line.at(-1)!.value).toBe(88);
  });

  it('the receipt holds that last point, with its market and quote time (what How we got this reads)', async () => {
    const { er } = await run(88, CANDLES);
    const r = er.receipts.find((x) => x.op === 'movement')!;
    expect(r.args.series).toMatchObject({ last_t: NOW });
    expect(r.provenance?.series).toEqual({ source: ID, as_of: AS_OF });
    // The line's last row in How we got this: the live price itself, from the same market and time.
    const last = er.receipts.filter((x) => x.op === 'price_at').at(-1)!;
    expect(last.value).toBe(88);
    expect(last.args.series).toMatchObject({ last_t: NOW });
    expect(last.provenance?.series).toEqual({ source: ID, as_of: AS_OF });
  });

  it('a candle at the quote’s own second is not counted twice, and one after it is dropped: the series stays sorted', async () => {
    const same = await run(88, [...CANDLES, { t: NOW, price_cents: 70 }]);
    expect(series(same.mn).filter((p) => p.t === NOW)).toEqual([{ t: NOW, v: 88 }]);
    const later = await run(88, [...CANDLES, { t: NOW + 1800, price_cents: 40 }]);
    expect(series(later.mn).at(-1)).toEqual({ t: NOW, v: 88 });
    expect(later.er.numbers.find((n) => n.op === 'movement')!.value).toBe(26);
  });

  it('the window is measured from the quote’s time, and the same inputs give the same answer', async () => {
    const a = await run(88, CANDLES);
    const b = await run(88, CANDLES);
    expect(a.er.receipts.find((x) => x.op === 'movement')!.input_hash).toBe(b.er.receipts.find((x) => x.op === 'movement')!.input_hash);
    expect(a.er.numbers).toEqual(b.er.numbers);
  });

  it('no candles: no series, as before (a lone quote is not a move)', async () => {
    const plan = defaultPlan(spec);
    const mn = await marketNumbers(stub(88, []), spec, plan);
    expect(mn.numbers.series_1).toBeUndefined();
  });
});
