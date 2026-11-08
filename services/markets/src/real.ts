import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MARKETS, SOURCE_CATALOG, type Market, type SourceRow } from '@app/contracts';
import { HttpError, createLogger, type Handlers, type Logger } from '@app/service-kit';
import { braveClient, type BraveClient } from './brave.ts';
import { TtlCache } from './cache.ts';
import { parseExtraDomains, toCandidates, type Link } from './candidates.ts';
import { mentions, parseFeed } from './feeds.ts';
import { eventKeyOf, kalshiEventOf, parseEventKey, parseKalshiTicker, polymarketSlugsOf, titleOf, type Game } from './games.ts';
import { kalshiClient, kalshiPoints, kalshiToMarket, type KalshiEventRaw } from './kalshi.ts';
import { gameStart, polymarketClient, polyToMarket, type PolyMarketRaw } from './polymarket.ts';
import { pairGame } from './pairing.ts';
import { memoryStore, postgresStore, type SearchRecord, type SearchStore } from './store.ts';
import { GAME_SERIES, type GameLeague } from './teams.ts';
import { UpstreamError, httpGet, type Fetch } from './upstream.ts';

/** markets' own settings (MARKETS_*). Times in seconds. */
export const MarketsConfig = z.object({
  QUOTE_TTL_S: z.coerce.number().int().min(10).max(30).default(15),
  LIST_TTL_S: z.coerce.number().int().min(10).max(300).default(30),
  HISTORY_TTL_S: z.coerce.number().int().min(10).max(3600).default(300),
  /** History requests per exchange per minute, at most (polite: they are spaced evenly). */
  HISTORY_PER_MIN: z.coerce.number().int().min(1).max(6000).default(20),
  /** A history request that would wait longer than this for its turn is refused (the cached copy is served if any). */
  HISTORY_MAX_WAIT_S: z.coerce.number().int().min(0).max(60).default(20),
  FEED_TTL_S: z.coerce.number().int().min(60).max(3600).default(600),
  SEARCH_TTL_S: z.coerce.number().int().min(300).max(86400).default(1800),
  FEED_MAX_AGE_H: z.coerce.number().int().min(6).max(720).default(96),
  BRAVE_KEY_FILE: z.string().default(join(homedir(), '.config/siren/secrets/brave-search')),
  SOURCE_ENV: z.enum(['prod', 'fixture']).default('prod'),
  DATABASE_URL: z.string().optional(),
});
export type MarketsConfig = z.infer<typeof MarketsConfig>;

export interface RealDeps {
  fetch?: Fetch;
  store?: SearchStore;
  log?: Logger;
  brave?: BraveClient;
  /** The clock for windows and freshness (tests pin it to when the fixtures were recorded). */
  now?: () => number;
  /** Kalshi, Gamma and CLOB base URLs (tests point them at recorded answers). */
  bases?: { kalshi?: string; gamma?: string; clob?: string };
}

type League = NonNullable<Market['league']>;
type Receipt = { provider: 'brave' | 'feeds' | 'catalog'; query: string | null; cached_at: string; shared_key: string };

const GAME_LEAGUES: GameLeague[] = ['nfl', 'nba'];
const iso = (ms: number) => new Date(ms).toISOString();
const isUpstream = (e: unknown) => e instanceof UpstreamError || e instanceof z.ZodError;
const down = (what: string) => new HttpError(503, 'upstream_unavailable', `${what} is unavailable and nothing is cached`);

/** The real markets: live public data from Kalshi and Polymarket, the catalog's feeds and Brave, all cached. */
export function real(rawCfg: Record<string, unknown> = {}, deps: RealDeps = {}): Handlers<typeof MARKETS> {
  const cfg = MarketsConfig.parse(rawCfg);
  const log = deps.log ?? createLogger('markets');
  const get = httpGet(deps.fetch);
  const kalshi = kalshiClient(get, deps.bases?.kalshi);
  const poly = polymarketClient(get, deps.bases?.gamma, deps.bases?.clob);
  const brave = deps.brave ?? braveClient({ keyFile: cfg.BRAVE_KEY_FILE, get, log });
  const store = deps.store ?? (cfg.DATABASE_URL ? postgresStore(cfg.DATABASE_URL) : memoryStore());
  const now = deps.now ?? Date.now;
  const cache = new TtlCache(5000, now);
  const rows: SourceRow[] = SOURCE_CATALOG.rows.filter((r) => r.env === cfg.SOURCE_ENV && r.verified);
  const ms = (seconds: number) => seconds * 1000;
  const spacers = { kalshi: spacer(60_000 / cfg.HISTORY_PER_MIN, ms(cfg.HISTORY_MAX_WAIT_S)), polymarket: spacer(60_000 / cfg.HISTORY_PER_MIN, ms(cfg.HISTORY_MAX_WAIT_S)) };
  const stale = { staleIf: isUpstream };

  // --- raw reads, cached by what they fetch (never by who asks) ---------------------------------------------------
  const kalshiMarket = (ticker: string) => cache.get(`k:m:${ticker}`, ms(cfg.QUOTE_TTL_S), () => kalshi.market(ticker), stale);
  const kalshiEvent = (eventTicker: string, ttlS = cfg.QUOTE_TTL_S) => cache.get(`k:e:${eventTicker}`, ms(ttlS), () => kalshi.event(eventTicker), stale);
  const polyMarket = (slug: string) => cache.get(`p:m:${slug}`, ms(cfg.QUOTE_TTL_S), () => poly.market(slug), stale);

  async function kalshiAsMarket(ticker: string): Promise<Market | null> {
    const m = await kalshiMarket(ticker);
    if (!m.value) return null;
    // A game names its own league and teams; any other market needs its event for the category.
    const ev = parseKalshiTicker(ticker) ? null : ((await kalshiEvent(m.value.event_ticker, 300)).value?.event ?? null);
    return kalshiToMarket(m.value, { asOf: iso(m.at), stale: m.stale, event: ev });
  }

  async function polyAsMarket(slug: string): Promise<{ market: Market; raw: PolyMarketRaw } | null> {
    const m = await polyMarket(slug);
    if (!m.value) return null;
    const market = polyToMarket(m.value, { asOf: iso(m.at), stale: m.stale });
    return market ? { market, raw: m.value } : null;
  }

  async function mustMarket(id: string): Promise<{ market: Market; raw: PolyMarketRaw | null }> {
    let found: { market: Market; raw: PolyMarketRaw | null } | null;
    try {
      if (id.startsWith('kalshi:')) {
        const market = await kalshiAsMarket(id.slice(7));
        found = market ? { market, raw: null } : null;
      } else found = await polyAsMarket(id.slice(11));
    } catch (err) {
      if (isUpstream(err)) throw down(id.split(':')[0]!);
      throw err;
    }
    if (!found) throw new HttpError(404, 'not_found', 'no such market (or not one this app covers)');
    return found;
  }

  /** A league's open games on Kalshi, each with its Polymarket moneyline when there is one. null: Kalshi is down. */
  async function leagueMarkets(league: GameLeague): Promise<Market[] | null> {
    let events: { value: KalshiEventRaw[]; at: number; stale: boolean };
    try {
      events = await cache.get(`k:list:${league}`, ms(cfg.LIST_TTL_S), () => kalshi.openEvents(GAME_SERIES[league]), stale);
    } catch (err) {
      if (!isUpstream(err)) throw err;
      log.warn({ league, err: (err as Error).message }, 'kalshi list failed');
      return null;
    }
    const out: Market[] = [];
    const games: Game[] = [];
    for (const ev of events.value) {
      const g = parseKalshiTicker(ev.event_ticker);
      if (g) games.push(g);
      for (const m of ev.markets ?? []) {
        if (!events.stale) cache.put(`k:m:${m.ticker}`, m, events.at); // a list read is also a fresh quote
        const mk = kalshiToMarket(m, { asOf: iso(events.at), stale: events.stale });
        if (mk) out.push(mk);
      }
    }
    const keys = new Set(games.map(eventKeyOf));
    const slugs = games.flatMap(polymarketSlugsOf);
    try {
      const pm = await cache.get(
        `p:list:${league}`,
        ms(cfg.LIST_TTL_S),
        async () => {
          const found: PolyMarketRaw[] = [];
          for (let i = 0; i < slugs.length; i += 40) found.push(...(await poly.markets(slugs.slice(i, i + 40))));
          return found;
        },
        stale,
      );
      for (const raw of pm.value) {
        const mk = polyToMarket(raw, { asOf: iso(pm.at), stale: pm.stale });
        if (mk && mk.event_key && keys.has(mk.event_key)) {
          out.push(mk);
          if (!pm.stale) cache.put(`p:m:${raw.slug}`, raw, pm.at); // like Kalshi's: a list read is also a fresh quote
        }
      }
    } catch (err) {
      if (!isUpstream(err)) throw err;
      log.warn({ league, err: (err as Error).message }, 'polymarket list failed');
    }
    return out;
  }

  // --- candidates ---------------------------------------------------------------------------------------------------
  const feedLinks = (url: string) =>
    cache.get(
      `feed:${url}`,
      ms(cfg.FEED_TTL_S),
      async () => {
        const got = await get(url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' }, maxBytes: 3_000_000 });
        if (got.status !== 200) throw new UpstreamError(new URL(url).hostname, got.status, `${new URL(url).hostname}: feed status ${got.status}`);
        return parseFeed(got.text);
      },
      stale,
    );

  /** One search per shared key (a game: both teams' markets on both exchanges share it), kept SEARCH_TTL_S. */
  async function searchLinks(sharedKey: string, query: string): Promise<SearchRecord | null> {
    const fresh = (r: SearchRecord) => now() - Date.parse(r.cached_at) < ms(cfg.SEARCH_TTL_S);
    const hit = cache.peek<SearchRecord>(sharedKey)?.value ?? null;
    if (hit && fresh(hit)) return hit;
    const stored = await store.get(sharedKey).catch((err: Error) => {
      log.warn({ err: err.message }, 'search store read failed');
      return null;
    });
    if (stored && fresh(stored)) {
      cache.put(sharedKey, stored);
      return stored;
    }
    // Concurrent misses for one key share one search.
    const found = await cache.get(`${sharedKey}:run`, 2000, () => brave.search(query));
    if (!found.value) return stored ?? hit; // skipped (no key, rate limited, down): the last result, if any
    const rec: SearchRecord = { query, hits: found.value, cached_at: iso(found.at) };
    cache.put(sharedKey, rec);
    await store.put(sharedKey, rec).catch((err: Error) => log.warn({ err: err.message }, 'search store write failed'));
    return rec;
  }

  /** Built by code from the market (never typed by a model): a game's two teams and league, else its title. */
  function queryFor(m: Market, g: Game | null): string {
    if (g) return `${g.away.name} ${g.home.name} ${g.league.toUpperCase()}`;
    return m.title.replace(/["<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  return {
    list: async ({ query }) => {
      if (query.category && query.category !== 'sports') return { markets: [] }; // sports first: other categories later
      const leagues = query.league ? GAME_LEAGUES.filter((l) => l === query.league) : GAME_LEAGUES;
      const lists = await Promise.all(leagues.map(leagueMarkets));
      if (leagues.length && lists.every((l) => l === null)) throw down('kalshi');
      const q = query.q?.toLowerCase();
      const markets = lists.flatMap((l) => l ?? []).filter((m) => !q || m.title.toLowerCase().includes(q));
      markets.sort((a, b) => (a.event_key ?? '').localeCompare(b.event_key ?? '') || a.market_id.localeCompare(b.market_id));
      return { markets };
    },

    get: async ({ params }) => (await mustMarket(params.market_id)).market,

    history: async ({ params, query }) => {
      const { market, raw } = await mustMarket(params.market_id);
      const w = query.window_s;
      // One fetch per market serves every window up to 7 days (hourly points); shorter than 6 h asks for minutes.
      const span = w <= 6 * 3600 ? w : Math.max(w, 7 * 86400);
      try {
        const h = await cache.get(
          `h:${market.market_id}:${span}`,
          ms(cfg.HISTORY_TTL_S),
          () =>
            spacers[market.exchange].run(market.exchange, async () => {
              const end = Math.floor(now() / 1000);
              if (market.exchange === 'kalshi') {
                const ticker = market.market_id.slice(7);
                const period = span <= 6 * 3600 ? 1 : span <= 7 * 86400 ? 60 : 1440;
                const c = await kalshi.candles(ticker.split('-')[0]!, ticker, end - span, end, period);
                return c ? kalshiPoints(c) : [];
              }
              const token = raw?.clobTokenIds?.[0];
              if (!token) return [];
              const pts = (await poly.history(token, span)) ?? [];
              return pts.map((p) => ({ t: p.t, price_cents: Math.min(100, Math.max(0, Math.round(p.p * 1000) / 10)) }));
            }),
          stale,
        );
        // The window ends at the series' last point, as the engine's movement reads it, so a 24 h move is the same
        // whether it comes from the 24 h or the 7-day series.
        const from = (h.value.at(-1)?.t ?? 0) - w;
        return { market_id: market.market_id, points: h.value.filter((p) => p.t >= from), as_of: iso(h.at) };
      } catch (err) {
        if (isUpstream(err)) throw down(market.exchange);
        throw err;
      }
    },

    event: async ({ params }) => {
      const g = parseEventKey(params.event_key);
      if (!g) throw new HttpError(404, 'not_found', 'no such event');
      const polyOf = async () => {
        for (const slug of polymarketSlugsOf(g)) {
          const r = await polyAsMarket(slug);
          if (r && r.market.event_key === eventKeyOf(g)) return r;
        }
        return null;
      };
      const [k, p] = await Promise.allSettled([kalshiEvent(kalshiEventOf(g)), polyOf()]);
      for (const r of [k, p]) if (r.status === 'rejected' && !isUpstream(r.reason)) throw r.reason;
      const markets: Market[] = [];
      if (k.status === 'fulfilled' && k.value.value) {
        for (const m of k.value.value.markets) {
          const mk = kalshiToMarket(m, { asOf: iso(k.value.at), stale: k.value.stale });
          if (mk) markets.push(mk);
        }
      }
      let starts: string | null = null;
      if (p.status === 'fulfilled' && p.value) {
        markets.push(p.value.market);
        starts = gameStart(p.value.raw.gameStartTime);
      }
      if (!markets.length) {
        if (k.status === 'rejected' || p.status === 'rejected') throw down('the exchanges');
        throw new HttpError(404, 'not_found', 'no market for this event');
      }
      const event_key = eventKeyOf(g);
      const pairing =
        k.status === 'rejected'
          ? { paired: false as const, reason: "Kalshi isn't answering right now." }
          : p.status === 'rejected'
            ? { paired: false as const, reason: "Polymarket isn't answering right now." }
            : pairGame(event_key, k.value.value?.markets ?? [], p.value?.raw ?? null);
      return { event_key, title: titleOf(g), starts_at: starts, markets, pairing };
    },

    candidates: async ({ params, query }) => {
      const { market } = await mustMarket(params.market_id);
      const game = market.event_key ? parseEventKey(market.event_key) : null;
      const teams = game ? [game.away, game.home] : [];
      const league = market.league as League | null;
      const mine = rows.filter((r) => r.category === market.category && (!league || r.leagues.includes(league)));
      // A game reads its two teams' feeds and its league's league-wide feeds.
      const feeds = mine.flatMap((r) => r.feeds.filter((f) => (f.team ? teams.some((t) => t.code === f.team) : feedLeague(f.url, league))));
      const since = now() - cfg.FEED_MAX_AGE_H * 3600_000;
      const links: Link[] = [];
      let feedsAt: number | null = null;
      const got = await Promise.allSettled(feeds.map(async (f) => ({ f, r: await feedLinks(f.url) })));
      for (const g of got) {
        if (g.status === 'rejected') {
          log.warn({ err: (g.reason as Error).message }, 'feed failed');
          continue;
        }
        const { f, r } = g.value;
        feedsAt = Math.min(feedsAt ?? r.at, r.at);
        const items = r.value
          .filter((i) => !i.published_at || Date.parse(i.published_at) >= since)
          .filter((i) => f.team || !teams.length || teams.some((t) => mentions(i.text, t.nickname)))
          .slice(0, 15);
        for (const i of items) links.push({ url: i.url, domain: i.domain, published_at: i.published_at, via: 'feed' });
      }
      const receipts: Receipt[] = [];
      if (feeds.length)
        receipts.push({
          provider: 'feeds',
          query: null,
          cached_at: iso(feedsAt ?? now()),
          shared_key: `feeds:${league ?? market.category}:${teams.map((t) => t.code).join('-') || 'all'}`,
        });
      const sharedKey = `brave:${market.event_key ?? market.market_id}`;
      const search = await searchLinks(sharedKey, queryFor(market, game));
      if (search) {
        for (const h of search.hits) links.push({ ...h, via: 'search' });
        receipts.push({ provider: 'brave', query: search.query, cached_at: search.cached_at, shared_key: sharedKey });
      }
      return { market_id: market.market_id, candidates: toCandidates(links, rows, parseExtraDomains(query.extra_domains)), receipts };
    },
  };
}

/**
 * Spaces one exchange's history requests at least `gapMs` apart, by the wall clock (a pinned test clock doesn't move).
 * A request whose turn is more than `maxWaitMs` away is refused as an upstream error, so the cache serves its last copy.
 */
export function spacer(gapMs: number, maxWaitMs: number, clock: () => number = Date.now) {
  let next = 0;
  return {
    async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
      const t = clock();
      const at = Math.max(t, next);
      if (at - t > maxWaitMs) throw new UpstreamError(host, null, `${host}: history requests are spaced out; try again shortly`);
      next = at + gapMs;
      if (at > t) await new Promise((r) => setTimeout(r, at - t));
      return fn();
    },
  };
}

/** A league-wide row lists one feed per league: keep the one whose URL names this market's league. */
function feedLeague(url: string, league: League | null): boolean {
  if (!league) return true;
  const named = ['nfl', 'nba', 'mlb', 'nhl'].filter((l) => url.toLowerCase().includes(l));
  return named.length === 0 || named.includes(league);
}
