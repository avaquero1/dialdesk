import { z } from 'zod';
import { Cents, EventKey, Exchange, MarketId, Timestamp } from '../common.ts';
import { api } from '../endpoint.ts';
import { League, MarketCategory, Candidate } from '../sources.ts';

export const Market = z
  .object({
    market_id: MarketId,
    exchange: Exchange,
    event_key: EventKey.nullable().describe('null when markets has not paired it with an event'),
    title: z.string().max(200),
    category: MarketCategory,
    league: League.nullable(),
    yes_price_cents: Cents.describe('last traded YES price'),
    yes_bid_cents: Cents.nullable(),
    yes_ask_cents: Cents.nullable(),
    previous_price_cents: Cents.nullable().describe('24 h ago'),
    volume: z.number().min(0),
    close_time: Timestamp.nullable(),
    as_of: Timestamp,
    stale: z.boolean().describe('true when the exchange was down and this is the last cached price'),
  })
  .strict();
export type Market = z.infer<typeof Market>;

export const PricePoint = z.object({ t: z.number().int().describe('unix seconds'), price_cents: z.number().min(0).max(100) }).strict();

export const SearchReceipt = z
  .object({
    provider: z.enum(['brave', 'feeds', 'catalog']),
    query: z.string().max(300).nullable().describe('built by code from the catalog entry, never typed by a model'),
    cached_at: Timestamp,
    shared_key: z.string().describe('the per-market cache key every follower shares'),
  })
  .strict();

const mid = z.object({ market_id: MarketId });

export const MARKETS = api('markets', {
  list: {
    method: 'GET',
    path: '/markets',
    callers: ['agent', 'runner'],
    query: z.object({ category: MarketCategory.optional(), league: League.optional(), q: z.string().max(80).optional() }),
    response: z.object({ markets: z.array(Market) }).strict(),
    summary: 'Find markets (the agent proposes widgets from these).',
  },
  get: {
    method: 'GET',
    path: '/markets/:market_id',
    callers: ['agent', 'runner', 'board'],
    params: mid,
    response: Market,
    errors: [404],
    summary: "One market, cached 10-30 s. quote_market reads this; board reads it for a new widget's first paint.",
  },
  history: {
    method: 'GET',
    path: '/markets/:market_id/history',
    callers: ['runner'],
    params: mid,
    query: z.object({ window_s: z.coerce.number().int().min(3600).max(30 * 86400) }),
    response: z.object({ market_id: MarketId, points: z.array(PricePoint), as_of: Timestamp }).strict(),
    errors: [404],
    summary: 'Price history for movement, volatility and the 7-day line.',
  },
  event: {
    method: 'GET',
    path: '/events/:event_key',
    callers: ['agent', 'runner'],
    params: z.object({ event_key: EventKey }),
    response: z.object({ event_key: EventKey, title: z.string(), starts_at: Timestamp.nullable(), markets: z.array(Market) }).strict(),
    errors: [404],
    summary: "One event's markets on both exchanges (for gap).",
  },
  candidates: {
    method: 'GET',
    path: '/markets/:market_id/candidates',
    callers: ['runner'],
    params: mid,
    query: z.object({ extra_domains: z.string().max(2000).optional().describe("comma-separated: the widget's user-added domains") }),
    response: z.object({ market_id: MarketId, candidates: z.array(Candidate), receipts: z.array(SearchReceipt) }).strict(),
    errors: [404],
    summary: 'Step 0, code only: candidate links for a market from the catalog, feeds and Brave, shared by every follower.',
  },
});
