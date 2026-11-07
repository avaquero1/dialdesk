import { MarketId, type Numbers } from '@app/contracts';
import type { KalshiMarketPosition } from './kalshi.ts';
import type { PolyPosition } from './polymarket.ts';

/** Exchange answers become numbers only: market id, side, count, average price. Nothing else leaves connections. */
type Pos = Numbers['positions'][number];
const cents = (n: number) => Math.min(100, Math.max(0, Math.round(n * 100) / 100));
const validMarket = (id: string) => MarketId.safeParse(id).success;

/** Kalshi: position_fp is signed (YES > 0, NO < 0); market_exposure_dollars is the cost basis of what is held. */
export function kalshiPositions(rows: KalshiMarketPosition[]): Pos[] {
  const out: Pos[] = [];
  for (const r of rows) {
    const signed = r.position_fp !== undefined ? Number(r.position_fp) : (r.position ?? 0);
    if (!Number.isFinite(signed) || signed === 0) continue;
    const market_id = `kalshi:${r.ticker}`;
    if (!validMarket(market_id)) continue;
    const count = Math.abs(signed);
    const exposureCents = r.market_exposure_dollars !== undefined ? Number(r.market_exposure_dollars) * 100 : (r.market_exposure ?? 0);
    out.push({ market_id, side: signed > 0 ? 'yes' : 'no', count, avg_price_cents: cents(Number.isFinite(exposureCents) ? exposureCents / count : 0) });
  }
  return out;
}

/** Polymarket: prices are USDC per share (0–1). Only Yes/No outcomes map to a side; index 999 means unlabelled. */
export function polymarketPositions(rows: PolyPosition[]): Pos[] {
  const out: Pos[] = [];
  for (const r of rows) {
    if (!(r.current_size > 0)) continue;
    const o = r.outcome.trim().toLowerCase();
    const side = o === 'yes' ? 'yes' : o === 'no' ? 'no' : r.outcome_index === 0 ? 'yes' : r.outcome_index === 1 ? 'no' : null;
    if (!side) continue;
    const market_id = `polymarket:${r.slug}`;
    if (!validMarket(market_id)) continue;
    out.push({ market_id, side, count: r.current_size, avg_price_cents: cents(r.avg_price * 100) });
  }
  return out;
}
