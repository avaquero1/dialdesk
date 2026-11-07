import { MARKETS, SOURCE_CATALOG, newId, type Candidate, type Market } from '@app/contracts';
import { HttpError, now, type Handlers } from '@app/service-kit';
import { fixtures } from '@app/testkit';

export type FakeDeps = Record<string, never>;
export async function fakeDepsFromEnv(): Promise<FakeDeps> {
  return {};
}

/** Fixture-backed markets: the made-up Kalshi and Polymarket JSON in fixtures/markets, and the fixture site. */
export function fake(_deps: FakeDeps = {}): Handlers<typeof MARKETS> {
  const pairs = fixtures.pairs();
  const poly = new Map(fixtures.polyMarkets().map((m) => [m.slug, m]));
  const asOf = now();
  const markets = new Map<string, Market>();
  for (const p of pairs) {
    const league = p.league.toLowerCase() as Market['league'];
    const k = fixtures.kalshiMarket(p.kalshi_ticker);
    markets.set(`kalshi:${k.ticker}`, {
      market_id: `kalshi:${k.ticker}`,
      exchange: 'kalshi',
      event_key: p.event_key,
      title: k.title,
      category: 'sports',
      league,
      yes_price_cents: k.last_price,
      yes_bid_cents: k.yes_bid,
      yes_ask_cents: k.yes_ask,
      previous_price_cents: k.previous_price,
      volume: k.volume,
      close_time: k.close_time,
      as_of: asOf,
      stale: false,
    });
    const pm = poly.get(p.polymarket_slug);
    if (pm) {
      const yes = Math.round(Number((JSON.parse(pm.outcomePrices) as string[])[0]) * 100);
      const move = Math.round((pm.oneDayPriceChange ?? 0) * 100);
      markets.set(`polymarket:${pm.slug}`, {
        market_id: `polymarket:${pm.slug}`,
        exchange: 'polymarket',
        event_key: p.event_key,
        title: pm.question,
        category: 'sports',
        league,
        yes_price_cents: yes,
        yes_bid_cents: pm.bestBid !== undefined ? Math.round(pm.bestBid * 100) : null,
        yes_ask_cents: pm.bestAsk !== undefined ? Math.round(pm.bestAsk * 100) : null,
        previous_price_cents: yes - move,
        volume: pm.volumeNum,
        close_time: pm.endDate,
        as_of: asOf,
        stale: false,
      });
    }
  }
  const get = (id: string) => {
    const m = markets.get(id);
    if (!m) throw new HttpError(404, 'not_found', 'no such market');
    return m;
  };

  // Candidates: each fixture page whose league matches, on catalog domains (allowed) or added domains.
  const pages = fixtures.manifest();
  const candidateIds = new Map(pages.map((p) => [p.url, newId('cnd')]));

  return {
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
          ? fixtures.kalshiCandles(m.market_id.slice(7)).map((c) => ({ t: c.end_period_ts, price_cents: c.price.close }))
          : fixtures.polyHistory(m.market_id.slice(11)).map((h) => ({ t: h.t, price_cents: Math.round(h.p * 100) }));
      const last = raw.at(-1)?.t ?? 0;
      return { market_id: m.market_id, points: raw.filter((p) => p.t >= last - query.window_s), as_of: asOf };
    },
    event: ({ params }) => {
      const p = pairs.find((x) => x.event_key === params.event_key);
      if (!p) throw new HttpError(404, 'not_found', 'no such event');
      return { event_key: p.event_key, title: p.title, starts_at: p.starts_at, markets: [...markets.values()].filter((m) => m.event_key === p.event_key) };
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
