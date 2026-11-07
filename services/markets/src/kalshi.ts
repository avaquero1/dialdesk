import { z } from 'zod';
import type { Market } from '@app/contracts';

type League = NonNullable<Market['league']>;
type MarketCategory = Market['category'];
import { eventKeyOf, parseKalshiTicker, titleOf } from './games.ts';
import { getJson, type HttpGet } from './upstream.ts';

/**
 * Kalshi's public market data (no key): https://api.elections.kalshi.com/trade-api/v2.
 * Shapes checked against the live API on 2026-11-07. Kalshi no longer sends integer cents (`yes_bid`, `last_price`,
 * `volume`): prices are dollar strings (`yes_bid_dollars: "0.4500"`) and counts are fixed-point strings (`volume_fp`).
 */
export const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

const Dollars = z.string().regex(/^\d+(\.\d+)?$/);
const Fp = z.string().regex(/^-?\d+(\.\d+)?$/);

export const KalshiMarketRaw = z.object({
  ticker: z.string(),
  event_ticker: z.string(),
  market_type: z.string(),
  title: z.string(),
  yes_sub_title: z.string().optional(),
  status: z.string(),
  close_time: z.string(),
  last_price_dollars: Dollars,
  yes_bid_dollars: Dollars,
  yes_ask_dollars: Dollars,
  previous_price_dollars: Dollars.optional(),
  volume_fp: Fp,
});
export type KalshiMarketRaw = z.infer<typeof KalshiMarketRaw>;

export const KalshiEventRaw = z.object({
  event_ticker: z.string(),
  series_ticker: z.string(),
  title: z.string(),
  sub_title: z.string().optional(),
  category: z.string(),
  markets: z.array(KalshiMarketRaw).optional(),
});
export type KalshiEventRaw = z.infer<typeof KalshiEventRaw>;

export const KalshiMarketOne = z.object({ market: KalshiMarketRaw });
export const KalshiEventOne = z.object({ event: KalshiEventRaw, markets: z.array(KalshiMarketRaw) });
export const KalshiEventsPage = z.object({ events: z.array(KalshiEventRaw), cursor: z.string().optional() });

const Ohlc = z.object({ close_dollars: Dollars.nullish(), previous_dollars: Dollars.nullish() });
export const KalshiCandles = z.object({
  ticker: z.string(),
  candlesticks: z.array(
    z.object({
      end_period_ts: z.number().int(),
      price: Ohlc,
      yes_bid: z.object({ close_dollars: Dollars.nullish() }).optional(),
      yes_ask: z.object({ close_dollars: Dollars.nullish() }).optional(),
    }),
  ),
});
export type KalshiCandles = z.infer<typeof KalshiCandles>;

export const cents = (d: string) => Math.min(100, Math.max(0, Math.round(Number(d) * 100)));
const centsExact = (d: string) => Math.min(100, Math.max(0, Math.round(Number(d) * 1000) / 10));
const iso = (s: string) => new Date(s).toISOString();

const CATEGORIES: Record<string, MarketCategory> = {
  Sports: 'sports',
  Politics: 'politics',
  Elections: 'politics',
  Economics: 'economics',
  Financials: 'economics',
  Crypto: 'crypto',
};
const LEAGUE_PREFIX: [RegExp, League][] = [
  [/^KXNFL/, 'nfl'],
  [/^KXNBA/, 'nba'],
  [/^KXMLB/, 'mlb'],
  [/^KXNHL/, 'nhl'],
  [/^KXNCAAF/, 'ncaaf'],
  [/^KXNCAAMB/, 'ncaab'],
];

export interface MapOpts {
  asOf: string;
  stale?: boolean;
  event?: KalshiEventRaw | null;
  /** The fake pins its fixture event keys and titles here. */
  eventKey?: string | null;
  title?: string;
}

/** One Kalshi market in our shape, or null when its category is one this app doesn't cover. */
export function kalshiToMarket(m: KalshiMarketRaw, o: MapOpts): Market | null {
  const game = parseKalshiTicker(m.ticker);
  const category = game ? 'sports' : o.event ? CATEGORIES[o.event.category] : undefined;
  if (!category) return null;
  const series = o.event?.series_ticker ?? m.event_ticker.split('-')[0]!;
  const league = game?.league ?? LEAGUE_PREFIX.find(([re]) => re.test(series))?.[1] ?? null;
  const bid = cents(m.yes_bid_dollars);
  const ask = cents(m.yes_ask_dollars);
  const title =
    o.title ??
    (game?.yes ? `${titleOf(game)}: ${game.yes.nickname} win` : o.event && m.yes_sub_title ? `${o.event.title}: ${m.yes_sub_title}` : m.title);
  return {
    market_id: `kalshi:${m.ticker}`,
    exchange: 'kalshi',
    event_key: o.eventKey !== undefined ? o.eventKey : game ? eventKeyOf(game) : null,
    title: title.slice(0, 200),
    category,
    league,
    yes_price_cents: cents(m.last_price_dollars),
    yes_bid_cents: bid > 0 ? bid : null,
    yes_ask_cents: ask < 100 ? ask : null,
    previous_price_cents: m.previous_price_dollars !== undefined ? cents(m.previous_price_dollars) : null,
    volume: Number(m.volume_fp),
    close_time: iso(m.close_time),
    as_of: o.asOf,
    stale: o.stale ?? false,
  };
}

/** Candles to price points: the period's last trade, else the previous trade, else the bid/ask middle. */
export function kalshiPoints(c: KalshiCandles): { t: number; price_cents: number }[] {
  const out: { t: number; price_cents: number }[] = [];
  for (const k of c.candlesticks) {
    const p = k.price.close_dollars ?? k.price.previous_dollars;
    const bid = k.yes_bid?.close_dollars;
    const ask = k.yes_ask?.close_dollars;
    const price = p ? centsExact(p) : bid && ask ? Math.round(((Number(bid) + Number(ask)) / 2) * 1000) / 10 : null;
    if (price !== null) out.push({ t: k.end_period_ts, price_cents: price });
  }
  return out;
}

/** The client. Each call is one GET; the caller caches. */
export function kalshiClient(get: HttpGet, base = KALSHI_BASE) {
  const json = (path: string) => getJson(get, `${base}${path}`);
  return {
    async market(ticker: string) {
      const r = await json(`/markets/${encodeURIComponent(ticker)}`);
      return r === null ? null : KalshiMarketOne.parse(r).market;
    },
    async event(eventTicker: string) {
      const r = await json(`/events/${encodeURIComponent(eventTicker)}`);
      return r === null ? null : KalshiEventOne.parse(r);
    },
    /** Open events of one series with their markets (one page of up to 200 is plenty for a league's games). */
    async openEvents(series: string) {
      const r = await json(`/events?series_ticker=${encodeURIComponent(series)}&status=open&limit=200&with_nested_markets=true`);
      return r === null ? [] : KalshiEventsPage.parse(r).events;
    },
    async candles(series: string, ticker: string, startTs: number, endTs: number, periodMin: 1 | 60 | 1440) {
      const q = `start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodMin}`;
      const r = await json(`/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks?${q}`);
      return r === null ? null : KalshiCandles.parse(r);
    },
  };
}
export type KalshiClient = ReturnType<typeof kalshiClient>;
