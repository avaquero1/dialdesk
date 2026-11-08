import type { ResolvedHistory, ResolvedRecord } from '@app/contracts';
import { eventKeyOf, parseKalshiTicker } from './games.ts';
import { kalshiGameStart, kalshiPoints, type KalshiCandlesBatch, type KalshiClient, type KalshiSettledRaw } from './kalshi.ts';
import { GAME_SERIES, SEASON_START, type GameLeague } from './teams.ts';

/** One settled game market this season, before its price is known. */
export interface Settled {
  ticker: string;
  event_key: string;
  home: boolean;
  /** ET game day, YYYY-MM-DD (from the ticker) */
  day: string;
  start: number;
  outcome: 0 | 1 | null;
}

/** Markets per batch-candles request (Kalshi takes up to 100). */
const BATCH = 50;
/** How far before the earliest start of a day the candles begin: the last hourly price before each start is in it. */
const LEAD_S = 3 * 3600;

/** A league's settled game winners this season, by code from Kalshi's tickers. Ties and other leagues' games are dropped. */
export function settledGames(league: GameLeague, raw: KalshiSettledRaw[]): { games: Settled[]; ties: number } {
  const since = SEASON_START[league];
  const games: Settled[] = [];
  const tiedEvents = new Set<string>();
  for (const m of raw) {
    const g = parseKalshiTicker(m.ticker);
    if (!g?.yes || g.league !== league || g.date < since || m.status !== 'finalized') continue;
    const outcome = m.result === 'yes' ? 1 : m.result === 'no' ? 0 : null;
    if (outcome === null) tiedEvents.add(m.event_ticker);
    games.push({ ticker: m.ticker, event_key: eventKeyOf(g), home: g.yes === g.home, day: g.date, start: kalshiGameStart(m), outcome });
  }
  games.sort((a, b) => a.start - b.start || a.ticker.localeCompare(b.ticker));
  return { games, ties: tiedEvents.size };
}

/** One batch-candles request: up to BATCH markets of one game day, from LEAD_S before the first start to the last start. */
export interface DayChunk {
  games: Settled[];
  start: number;
  end: number;
}

/** The requests that price `games` (the ones that resolved YES or NO), a game day at a time, oldest first. */
export function dayChunks(games: Settled[]): DayChunk[] {
  const days = new Map<string, Settled[]>();
  for (const g of games) if (g.outcome !== null) days.set(g.day, [...(days.get(g.day) ?? []), g]);
  const out: DayChunk[] = [];
  for (const day of days.values())
    for (let i = 0; i < day.length; i += BATCH) {
      const chunk = day.slice(i, i + BATCH);
      out.push({ games: chunk, start: Math.min(...chunk.map((g) => g.start)) - LEAD_S, end: Math.max(...chunk.map((g) => g.start)) });
    }
  return out;
}

type Price = { t: number; price_cents: number } | null;

/** Each game's last hourly price at or before its start, from one batch answer. A market missing from it is left out. */
export function pricesFrom(chunk: DayChunk, got: KalshiCandlesBatch | null): Map<string, Price> {
  const byTicker = new Map((got?.markets ?? []).map((m) => [m.market_ticker, m.candlesticks]));
  const out = new Map<string, Price>();
  for (const g of chunk.games) {
    const candles = byTicker.get(g.ticker);
    if (!candles) continue; // not in the answer: still pending, asked again next time
    out.set(g.ticker, kalshiPoints({ ticker: g.ticker, candlesticks: candles }).filter((p) => p.t <= g.start).at(-1) ?? null);
  }
  return out;
}

/**
 * The prices before each game, fetched a game day at a time (dayChunks) and kept for good: a settled game's past
 * never changes. `fill` walks the chunks not fetched yet through `turn` (the polite spacer); one fill runs per league
 * at a time, and a caller waits for it only up to its own budget.
 */
export function pregamePrices(kalshi: KalshiClient, turn: <T>(fn: () => Promise<T>) => Promise<T>) {
  const prices = new Map<string, Price>();
  const running = new Map<GameLeague, Promise<void>>();

  function fill(league: GameLeague, games: Settled[]): Promise<void> {
    const cur = running.get(league);
    if (cur) return cur;
    const chunks = dayChunks(games.filter((g) => !prices.has(g.ticker)));
    if (!chunks.length) return Promise.resolve();
    const p = (async () => {
      for (const c of chunks) {
        const got = await turn(() => kalshi.candlesBatch(c.games.map((g) => g.ticker), c.start, c.end, 60));
        for (const [t, v] of pricesFrom(c, got)) prices.set(t, v);
      }
    })().finally(() => running.delete(league));
    running.set(league, p);
    return p;
  }

  return { prices, fill };
}

/** The answer: the games priced so far as engine-ready records, and what was left out and why. */
export function resolvedAnswer(
  league: GameLeague,
  s: { games: Settled[]; ties: number },
  prices: Map<string, Price>,
  asOf: string,
): ResolvedHistory {
  const records: ResolvedRecord[] = [];
  let no_price = 0;
  let pending = 0;
  for (const g of s.games) {
    if (g.outcome === null) continue;
    if (!prices.has(g.ticker)) pending++;
    else {
      const p = prices.get(g.ticker);
      if (!p) no_price++;
      else records.push({ market_id: `kalshi:${g.ticker}`, event_key: g.event_key, home: g.home, t: p.t, price_cents: p.price_cents, outcome: g.outcome });
    }
  }
  return {
    league,
    kind: 'game_winner',
    exchange: 'kalshi',
    series: GAME_SERIES[league],
    season_start: SEASON_START[league],
    records,
    left_out: { ties: s.ties, no_price, pending },
    as_of: asOf,
  };
}
