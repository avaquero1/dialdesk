import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo's fixtures/ folder. */
export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures');

export function readFixture<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, rel), 'utf8')) as T;
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  yes_bid: number;
  yes_ask: number;
  last_price: number;
  previous_price: number;
  volume: number;
  close_time: string;
}
export interface PolyMarket {
  slug: string;
  question: string;
  outcomePrices: string;
  bestBid?: number;
  bestAsk?: number;
  volumeNum: number;
  endDate: string;
  oneDayPriceChange?: number;
}
export interface Pair {
  event_key: string;
  league: string;
  title: string;
  starts_at: string;
  kalshi_ticker: string;
  polymarket_slug: string;
}
export interface ManifestPage {
  url: string;
  file: string;
  poisoned: boolean;
  injections: string[];
  callouts: string[];
}

export const fixtures = {
  pairs: () => readFixture<Pair[]>('markets/pairs.json'),
  kalshiMarket: (ticker: string) => readFixture<{ market: KalshiMarket }>(`markets/kalshi/market-${ticker}.json`).market,
  kalshiCandles: (ticker: string) =>
    readFixture<{ candlesticks: { end_period_ts: number; price: { close: number } }[] }>(`markets/kalshi/candlesticks-${ticker}.json`).candlesticks,
  polyMarkets: () => readFixture<PolyMarket[]>('markets/polymarket/markets.json'),
  polyHistory: (slug: string) => readFixture<{ history: { t: number; p: number }[] }>(`markets/polymarket/prices-history-${slug}.json`).history,
  kalshiBalance: () => readFixture<{ balance: number }>('markets/kalshi/portfolio-balance.json'),
  kalshiPositions: () =>
    readFixture<{ market_positions: { ticker: string; position: number; market_exposure: number; total_traded: number }[] }>(
      'markets/kalshi/portfolio-positions.json',
    ),
  manifest: () => readFixture<ManifestPage[]>('site/MANIFEST.json'),
  page: (file: string) => readFileSync(join(FIXTURES_DIR, 'site', file), 'utf8'),
};

/**
 * Page text the way a careless extractor sees it: tags stripped, hidden text and comments kept.
 * That's the point: the poisoned page's hidden orders reach the reader, and the guard has to catch them.
 */
export function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
