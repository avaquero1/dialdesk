/**
 * markets in real mode for `make e2e-real`: the real service (its own main.ts wiring, Postgres store, caches), with its
 * upstreams answered from the recording of this weekend's games (fixtures/markets/live/weekend). Real market data is
 * meeting point 2; here the exchanges are the recording, the fixture site's feeds (MARKETS_SOURCE_ENV=fixture) are the
 * real Compose fixtures server on 127.0.0.1:8300, search is the fixture web's pages, and every other host is refused, so the run never reaches the internet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKETS } from '@app/contracts';
import { runService } from '@app/service-kit';
import { FIXTURES_DIR } from '@app/testkit';
import { fake, fakeDepsFromEnv } from '../../services/markets/src/fake.ts';
import { real } from '../../services/markets/src/real.ts';
import { weekendFetch } from '../../services/markets/test/recorded.ts';

const rec = weekendFetch();
const live = (rel: string) => JSON.parse(readFileSync(join(FIXTURES_DIR, 'markets', 'live', 'weekend', rel), 'utf8')) as unknown;
type KEvent = { event_ticker: string; markets: { ticker: string }[] };
const events = ['KXNFLGAME', 'KXNBAGAME'].flatMap((s) => (live(`events-${s}.json`) as { events: KEvent[] }).events);
const polys = live('markets-by-slug.json') as { slug: string }[];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const missing = () => new Response('{"error":"not found"}', { status: 404 });

/**
 * The recording holds the list reads. A single market, an event and a slug are answered from those same lists (what
 * the exchanges answer for them, as of the recording); history is empty, so no price moved since the recording.
 */
function single(u: URL): Response | null {
  const p = u.pathname;
  let m: RegExpExecArray | null;
  if (u.hostname === 'api.elections.kalshi.com') {
    if ((m = /\/markets\/([^/]+)$/.exec(p))) {
      const market = events.flatMap((e) => e.markets).find((x) => x.ticker === decodeURIComponent(m![1]!));
      return market ? json({ market }) : missing();
    }
    if ((m = /\/events\/([^/]+)$/.exec(p))) {
      const ev = events.find((e) => e.event_ticker === decodeURIComponent(m![1]!));
      if (!ev) return missing();
      const { markets, ...event } = ev;
      return json({ event, markets });
    }
    if (p.endsWith('/candlesticks')) return json({ ticker: p.split('/').at(-2), candlesticks: [] });
  }
  if (u.hostname === 'gamma-api.polymarket.com' && (m = /^\/markets\/slug\/([^/]+)$/.exec(p))) {
    const market = polys.find((x) => x.slug === decodeURIComponent(m![1]!));
    return market ? json(market) : missing();
  }
  if (u.hostname === 'clob.polymarket.com' && p === '/prices-history') return json({ history: [] });
  return null;
}

const recorded = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (u.hostname === '127.0.0.1' && u.port === '8300') return fetch(input, init);
  if (['api.elections.kalshi.com', 'gamma-api.polymarket.com', 'clob.polymarket.com'].includes(u.hostname)) return single(u) ?? rec.fetch(input, init);
  throw new TypeError(`e2e-real: ${u.hostname} is not reachable from this run`);
}) as typeof fetch;

/**
 * Brave's stand-in: the fixture web's pages for the query's league (MANIFEST.json, with each page's own date). With no
 * Brave key, a game would read only the feed items that name its teams; this is the search hit list a key would add.
 */
type Page = { url: string; file: string };
const pages = JSON.parse(readFileSync(join(FIXTURES_DIR, 'site', 'MANIFEST.json'), 'utf8')) as Page[];
const brave = {
  search: async (query: string) => {
    const league = query.split(' ').at(-1)!.toLowerCase();
    return pages.filter((p) => new URL(p.url).pathname.startsWith(`/${league}/`)).map((p) => ({ url: p.url, domain: new URL(p.url).hostname, published_at: null }));
  },
  hasKey: async () => true,
};

await runService({
  service: 'markets',
  api: MARKETS,
  fake: async () => fake(await fakeDepsFromEnv()),
  real: (cfg) => real(cfg, { fetch: recorded, brave }),
  migrationsDir: fileURLToPath(new URL('../../services/markets/migrations', import.meta.url)),
});
