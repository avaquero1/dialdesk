import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKETS } from '@app/contracts';
import { buildApp, createLogger, type Logger } from '@app/service-kit';
import { FIXTURES_DIR, testCallers } from '@app/testkit';
import { real, type RealDeps } from '../src/real.ts';

/** When fixtures/markets/live was recorded (scripts/record-live.ts). Tests pin the clock here. */
export const RECORDED_AT = Date.parse('2026-11-07T12:40:00Z');
const live = (rel: string) => readFileSync(join(FIXTURES_DIR, 'markets', 'live', rel), 'utf8');

/** A fetch that answers from the recorded files and 404s everything else. It counts calls and keeps headers. */
export function recordedFetch() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let down = false;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (down) throw new TypeError('fetch failed');
    const u = new URL(url);
    const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    const xml = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
    const p = u.pathname;
    if (u.hostname === 'api.elections.kalshi.com') {
      if (p.endsWith('/events') && u.searchParams.get('series_ticker') === 'KXNFLGAME') return json(live('kalshi/events-KXNFLGAME.json'));
      if (p.endsWith('/events/KXNFLGAME-26NOV08NYJKC')) return json(live('kalshi/event-KXNFLGAME-26NOV08NYJKC.json'));
      if (p.endsWith('/markets/KXNFLGAME-26NOV08NYJKC-KC')) return json(live('kalshi/market-KXNFLGAME-26NOV08NYJKC-KC.json'));
      if (p.endsWith('/markets/KXNFLGAME-26NOV08NYJKC-KC/candlesticks')) return json(live('kalshi/candlesticks-KXNFLGAME-26NOV08NYJKC-KC.json'));
    }
    if (u.hostname === 'gamma-api.polymarket.com') {
      if (p === '/markets/slug/nfl-nyj-kc-2026-11-08') return json(live('polymarket/market-nfl-nyj-kc-2026-11-08.json'));
      if (p === '/markets') {
        const want = new Set(u.searchParams.getAll('slug'));
        const all = JSON.parse(live('polymarket/markets-by-slug.json')) as { slug: string }[];
        return json(JSON.stringify(all.filter((m) => want.has(m.slug))));
      }
    }
    if (u.hostname === 'clob.polymarket.com' && p === '/prices-history') return json(live('polymarket/prices-history-nfl-nyj-kc-2026-11-08.json'));
    if (url === 'https://www.newyorkjets.com/rss/news') return xml(live('feeds/nyj.xml'));
    if (url === 'https://www.chiefs.com/rss/news') return xml(live('feeds/kc.xml'));
    if (url === 'https://www.espn.com/espn/rss/nfl/news') return xml(live('feeds/espn-nfl.xml'));
    if (url === 'https://www.rotowire.com/rss/news.php?sport=NFL') return xml(live('feeds/rotowire-nfl.xml'));
    if (u.hostname === 'api.search.brave.com') return json(live('brave/news-search.json'));
    return new Response('{"error":"not found"}', { status: 404 });
  }) as typeof fetch;
  return {
    fetch: f,
    calls,
    setDown: (v: boolean) => {
      down = v;
    },
  };
}

/** A logger that keeps every line it is given, so tests can prove what is (and isn't) logged. */
export function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const write = (level: string) => (a: unknown, b?: unknown) => {
    lines.push(`${level} ${typeof a === 'string' ? a : JSON.stringify(a)} ${b === undefined ? '' : String(b)}`);
  };
  const log = { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), trace: write('trace'), fatal: write('fatal') } as unknown as Logger;
  (log as unknown as { child: () => Logger }).child = () => log;
  return { log, lines };
}

/** The real handlers behind the service template (real mode), with the contract checks on, as the gate runs them. */
export function realApp(cfg: Record<string, unknown>, deps: RealDeps) {
  return buildApp({ service: 'markets', mode: 'real', api: MARKETS, handlers: real(cfg, deps), callers: testCallers(), log: createLogger('markets', 'silent'), strictResponses: true });
}
