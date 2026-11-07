import { z } from 'zod';
import type { Market } from '@app/contracts';

type League = NonNullable<Market['league']>;
type MarketCategory = Market['category'];
import { etDate, eventKeyOf, parsePolymarketSlug, titleOf } from './games.ts';
import { getJson, type HttpGet } from './upstream.ts';

/**
 * Polymarket's public market data (no key): the Gamma API for markets, the CLOB API for price history.
 * Shapes checked against the live APIs on 2026-11-07. A game's market is a moneyline with the two teams as outcomes
 * (["Jets", "Chiefs"], away first), not Yes/No. Our YES for `polymarket:<slug>` is always the first outcome.
 */
export const GAMMA_BASE = 'https://gamma-api.polymarket.com';
export const CLOB_BASE = 'https://clob.polymarket.com';

/** Gamma sends lists as JSON inside a string: "[\"0.195\", \"0.805\"]". */
const JsonList = z.string().transform((s, ctx) => {
  try {
    const v = JSON.parse(s) as unknown;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  } catch {
    /* falls through */
  }
  ctx.addIssue({ code: 'custom', message: 'not a JSON list of strings' });
  return z.NEVER;
});

export const PolyMarketRaw = z.object({
  slug: z.string(),
  question: z.string(),
  outcomes: JsonList,
  outcomePrices: JsonList,
  clobTokenIds: JsonList.optional(),
  lastTradePrice: z.number().optional(),
  bestBid: z.number().optional(),
  bestAsk: z.number().optional(),
  oneDayPriceChange: z.number().optional(),
  volumeNum: z.number().optional(),
  endDate: z.string().optional(),
  gameStartTime: z.string().optional(),
  sportsMarketType: z.string().optional(),
  closed: z.boolean().optional(),
  tags: z.array(z.object({ slug: z.string() })).optional(),
  events: z.array(z.object({ slug: z.string(), title: z.string().optional() })).optional(),
});
export type PolyMarketRaw = z.infer<typeof PolyMarketRaw>;

export const PolyHistory = z.object({ history: z.array(z.object({ t: z.number().int(), p: z.number() })) });

const pct = (p: number) => Math.min(100, Math.max(0, Math.round(p * 100)));
const LEAGUES = new Set<League>(['nfl', 'nba', 'mlb', 'nhl', 'ncaaf', 'ncaab', 'soccer']);
const CATEGORY_TAGS: [string, MarketCategory][] = [
  ['sports', 'sports'],
  ['politics', 'politics'],
  ['elections', 'politics'],
  ['economy', 'economics'],
  ['finance', 'economics'],
  ['crypto', 'crypto'],
];

/** "2026-11-08 18:00:00+00" (Gamma's gameStartTime) to ISO. */
export function gameStart(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(s.replace(' ', 'T').replace(/\+00$/, 'Z'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface MapOpts {
  asOf: string;
  stale?: boolean;
  eventKey?: string | null;
  title?: string;
}

/** One Polymarket market in our shape, or null when it is in a category this app doesn't cover. */
export function polyToMarket(m: PolyMarketRaw, o: MapOpts): Market | null {
  const slugGame = parsePolymarketSlug(m.slug);
  const start = gameStart(m.gameStartTime);
  // The event key uses the kickoff's ET day, like Kalshi, whatever day the slug names.
  const game = slugGame && start ? { ...slugGame, date: etDate(start) } : slugGame;
  const tags = new Set((m.tags ?? []).map((t) => t.slug));
  const category: MarketCategory | undefined = game ? 'sports' : CATEGORY_TAGS.find(([t]) => tags.has(t))?.[1];
  if (!category || m.outcomePrices.length < 2) return null;
  const league = game?.league ?? ([...tags].find((t) => LEAGUES.has(t as League)) as League | undefined) ?? null;
  const first = Number(m.outcomePrices[0]);
  const yes = pct(m.lastTradePrice ?? first);
  const yesNo = m.outcomes[0]?.toLowerCase() === 'yes';
  const title = o.title ?? (game ? `${titleOf(game)}: ${game.away.nickname} win` : yesNo ? m.question : `${m.question}: ${m.outcomes[0]}`);
  const end = m.endDate ? new Date(m.endDate) : null;
  return {
    market_id: `polymarket:${m.slug}`,
    exchange: 'polymarket',
    event_key: o.eventKey !== undefined ? o.eventKey : game ? eventKeyOf(game) : null,
    title: title.slice(0, 200),
    category,
    league,
    yes_price_cents: yes,
    yes_bid_cents: m.bestBid !== undefined && m.bestBid > 0 ? pct(m.bestBid) : null,
    yes_ask_cents: m.bestAsk !== undefined && m.bestAsk < 1 ? pct(m.bestAsk) : null,
    previous_price_cents: m.oneDayPriceChange !== undefined ? pct((m.lastTradePrice ?? first) - m.oneDayPriceChange) : null,
    volume: m.volumeNum ?? 0,
    close_time: end && !Number.isNaN(end.getTime()) ? end.toISOString() : null,
    as_of: o.asOf,
    stale: o.stale ?? false,
  };
}

/** CLOB's history caps a startTs..endTs range, so we ask for a named interval and cut it to the window. */
export function historyInterval(windowS: number): { interval: string; fidelity: number } {
  if (windowS <= 6 * 3600) return { interval: '6h', fidelity: 1 };
  if (windowS <= 86400) return { interval: '1d', fidelity: 5 };
  if (windowS <= 7 * 86400) return { interval: '1w', fidelity: 60 };
  return { interval: '1m', fidelity: 360 };
}

export function polymarketClient(get: HttpGet, gamma = GAMMA_BASE, clob = CLOB_BASE) {
  return {
    async market(slug: string) {
      const r = await getJson(get, `${gamma}/markets/slug/${encodeURIComponent(slug)}?include_tag=true`);
      return r === null ? null : PolyMarketRaw.parse(r);
    },
    /** Several markets by slug in one call; unknown slugs are simply missing from the answer. */
    async markets(slugs: string[]) {
      if (!slugs.length) return [];
      const q = slugs.map((s) => `slug=${encodeURIComponent(s)}`).join('&');
      const r = await getJson(get, `${gamma}/markets?${q}&limit=${slugs.length}`);
      return r === null ? [] : z.array(PolyMarketRaw).parse(r);
    },
    async history(tokenId: string, windowS: number) {
      const { interval, fidelity } = historyInterval(windowS);
      const r = await getJson(get, `${clob}/prices-history?market=${encodeURIComponent(tokenId)}&interval=${interval}&fidelity=${fidelity}`);
      return r === null ? null : PolyHistory.parse(r).history;
    },
  };
}
export type PolymarketClient = ReturnType<typeof polymarketClient>;
