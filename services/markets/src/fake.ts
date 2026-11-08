import { MARKETS, SOURCE_CATALOG, newId, type Candidate, type GamePairing, type Market } from '@app/contracts';
import { HttpError, now, type Handlers } from '@app/service-kit';
import { fixtures, readFixture } from '@app/testkit';
import { KalshiCandles, KalshiCandlesBatch, KalshiMarketRaw, KalshiSettledPage, kalshiPoints, kalshiToMarket } from './kalshi.ts';
import { pricesFrom, resolvedAnswer, settledGames } from './resolved.ts';
import { GAME_SERIES, type GameLeague } from './teams.ts';
import { PolyMarketRaw, polyToMarket } from './polymarket.ts';

export type FakeDeps = Record<string, never>;
export async function fakeDepsFromEnv(): Promise<FakeDeps> {
  return {};
}

/** Fixture-backed markets: the made-up Kalshi and Polymarket JSON in fixtures/markets, and the fixture site. */
export function fake(_deps: FakeDeps = {}): Handlers<typeof MARKETS> {
  const pairs = fixtures.pairs();
  const poly = new Map<string, unknown>(fixtures.polyMarkets().map((m) => [m.slug, m]));
  const asOf = now();
  const markets = new Map<string, Market>();
  // The fixtures have the exchanges' live shapes; the fake reads them with the same parsers as the real service.
  for (const p of pairs) {
    const k = KalshiMarketRaw.parse(readFixture<{ market: unknown }>(`markets/kalshi/market-${p.kalshi_ticker}.json`).market);
    const km = kalshiToMarket(k, { asOf, eventKey: p.event_key });
    if (km) markets.set(km.market_id, km);
    const raw = poly.get(p.polymarket_slug);
    const pm = raw ? polyToMarket(PolyMarketRaw.parse(raw), { asOf, eventKey: p.event_key }) : null;
    if (pm) markets.set(pm.market_id, pm);
  }
  // The fixture pairs are declared by hand; a pair counts when both markets exist and say the same team wins on YES.
  const fakePairing = (p: { kalshi_ticker: string; polymarket_slug: string }): GamePairing => {
    const k = markets.get(`kalshi:${p.kalshi_ticker}`);
    const pm = markets.get(`polymarket:${p.polymarket_slug}`);
    const yes = (m: Market | undefined) => m?.title.split(': ')[1];
    if (!k || !pm) return { paired: false, reason: `${k ? 'Polymarket' : 'Kalshi'} has no market for this game.` };
    if (!yes(k) || yes(k) !== yes(pm)) return { paired: false, reason: "The two markets' YES may mean different teams win." };
    return { paired: true, kalshi: k.market_id, polymarket: pm.market_id, yes_means: yes(k)! };
  };
  const get = (id: string) => {
    const m = markets.get(id);
    if (!m) throw new HttpError(404, 'not_found', 'no such market');
    return m;
  };

  // Candidates: each fixture page whose league matches, on catalog domains (allowed) or added domains.
  const pages = fixtures.manifest();
  const candidateIds = new Map(pages.map((p) => [p.url, newId('cnd')]));

  return {
    resolved: ({ query }) => {
      if (query.league !== 'nfl' && query.league !== 'nba') throw new HttpError(404, 'not_found', `no resolved history for ${query.league} yet`);
      return recordedResolved(query.league);
    },
    list: ({ query }) => ({
      markets: [...markets.values()].filter(
        (m) =>
          (!query.category || m.category === query.category) &&
          (!query.league || m.league === query.league) &&
          (!query.q || m.title.toLowerCase().includes(query.q.toLowerCase())),
      ),
    }),
    get: ({ params }) => get(params.market_id),
    history: ({ params, query }) => {
      const m = get(params.market_id);
      const raw =
        m.exchange === 'kalshi'
          ? kalshiPoints(KalshiCandles.parse(readFixture(`markets/kalshi/candlesticks-${m.market_id.slice(7)}.json`)))
          : fixtures.polyHistory(m.market_id.slice(11)).map((h) => ({ t: h.t, price_cents: Math.round(h.p * 100) }));
      const last = raw.at(-1)?.t ?? 0;
      return { market_id: m.market_id, points: raw.filter((p) => p.t >= last - query.window_s), as_of: asOf };
    },
    event: ({ params }) => {
      const p = pairs.find((x) => x.event_key === params.event_key);
      if (!p) throw new HttpError(404, 'not_found', 'no such event');
      return { event_key: p.event_key, title: p.title, starts_at: p.starts_at, markets: [...markets.values()].filter((m) => m.event_key === p.event_key), pairing: fakePairing(p) };
    },
    candidates: ({ params, query }) => {
      const m = get(params.market_id);
      const extra = new Set((query.extra_domains ?? '').split(',').filter(Boolean));
      const league = m.league ?? '';
      const candidates: Candidate[] = pages
        .filter((p) => p.file.includes(`/${league}/`))
        .map((p) => {
          const domain = new URL(p.url).hostname;
          const row = SOURCE_CATALOG.rows.find((r) => r.domain === domain);
          return {
            candidate_id: candidateIds.get(p.url)!,
            url: p.url,
            domain,
            published_at: '2026-11-07T12:00:00Z',
            via: row?.feeds.length ? 'feed' : 'catalog',
            source_id: row?.source_id ?? null,
            allowed: !!row || extra.has(domain),
            title_for_user: null,
          };
        });
      return {
        market_id: m.market_id,
        candidates,
        receipts: [{ provider: 'feeds', query: null, cached_at: asOf, shared_key: `cand:${m.market_id}` }],
      };
    },
  };
}

/**
 * This season's settled games as markets.resolved answers them, from the recording in
 * fixtures/markets/live/weekend/resolved (scripts/record-resolved.ts), through the real service's own parsers.
 */
export function recordedResolved(league: GameLeague) {
  const dir = 'markets/live/weekend/resolved';
  const index = readFixture<{ recorded_at: string; files: { series: string; tickers: string[]; file: string }[] }>(`${dir}/resolved.json`);
  const series = GAME_SERIES[league];
  const s = settledGames(league, KalshiSettledPage.parse(readFixture(`${dir}/settled-${series}.json`)).markets);
  const byTicker = new Map(s.games.map((g) => [g.ticker, g]));
  const prices = new Map<string, { t: number; price_cents: number } | null>();
  for (const f of index.files.filter((x) => x.series === series)) {
    const chunk = { games: f.tickers.map((t) => byTicker.get(t)!).filter(Boolean), start: 0, end: 0 };
    for (const [t, v] of pricesFrom(chunk, KalshiCandlesBatch.parse(readFixture(`${dir}/${f.file}`)))) prices.set(t, v);
  }
  return resolvedAnswer(league, s, prices, index.recorded_at);
}

/** The recorded records in the engine's history shape, per league: every team's market, and the home teams' alone. */
export function engineHistory() {
  const shape = (rs: { t: number; price_cents: number; outcome: number }[]) => rs.map(({ t, price_cents, outcome }) => ({ t, price_cents, outcome }));
  const out: Record<string, { all: ReturnType<typeof shape>; home: ReturnType<typeof shape> }> = {};
  for (const league of ['nfl', 'nba'] as const) {
    const h = recordedResolved(league);
    out[league] = { all: shape(h.records), home: shape(h.records.filter((r) => r.home)) };
  }
  return out;
}
