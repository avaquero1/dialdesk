/**
 * Records a few real answers from the public APIs into fixtures/markets/live/, for the offline tests of the real
 * clients. Market data is kept as it came (trimmed to a few rows). Feeds keep their structure, links and dates, but
 * every headline and summary is replaced, so no outlet's text lands in the repo. A Brave answer is recorded only when
 * the key file exists, and keeps only links, dates and host names.
 *
 *   node --import tsx services/markets/scripts/record-live.ts [nfl-event-key]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KALSHI_BASE } from '../src/kalshi.ts';
import { CLOB_BASE, GAMMA_BASE } from '../src/polymarket.ts';
import { BRAVE_NEWS } from '../src/brave.ts';
import { kalshiEventOf, parseEventKey, parseKalshiTicker, polymarketSlugsOf } from '../src/games.ts';
import { TEAMS } from '../src/teams.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'markets', 'live');
const key = process.argv[2] ?? 'nfl-2026-11-08-nyj-kc';
const game = parseEventKey(key);
if (!game) throw new Error(`not a game event key: ${key}`);
const UA = { 'user-agent': 'vultr-hackathon-app-markets/0.1 (+fixture recorder)' };

async function json(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const r = await fetch(url, { headers: { ...UA, accept: 'application/json', ...headers } });
  if (!r.ok) throw new Error(`${new URL(url).hostname}: ${r.status}`);
  return r.json();
}
function save(rel: string, body: unknown) {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
  process.stderr.write(`wrote ${rel}\n`);
}

/** Headlines and summaries out; a note of which nicknames they named stays, so team matching can still be tested. */
function scrubFeed(xml: string): string {
  const named = (s: string) => TEAMS.filter((t) => new RegExp(`\\b${t.nickname}\\b`, 'i').test(s)).map((t) => t.nickname);
  const note = (s: string) => {
    const n = [...new Set(named(s))];
    return `Text removed for the fixture${n.length ? ` (names: ${n.join(', ')})` : ''}`;
  };
  return xml
    .replace(/<(title|subtitle|description|summary|content|content:encoded|media:title|media:description|media:text|media:keywords|category)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_, tag: string, attrs = '', body: string) => `<${tag}${attrs}>${note(body)}</${tag}>`)
    .replace(/<(dc:creator|author)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, '<$1$2>Fixture Author</$1>')
    .replace(/<(media:thumbnail|media:content|enclosure)\b[^>]*\/>/gi, '')
    .replace(/<(media:content|media:group)\b[\s\S]*?<\/\1>/gi, '');
}

const ticker = kalshiEventOf(game);
const series = ticker.split('-')[0]!;
const yes = `${ticker}-${game.home.kalshi}`;

// Kalshi
const events = (await json(`${KALSHI_BASE}/events?series_ticker=${series}&status=open&limit=200&with_nested_markets=true`)) as { events: { event_ticker: string }[] };
const keep = events.events.filter((e) => e.event_ticker === ticker).concat(events.events.filter((e) => e.event_ticker !== ticker).slice(0, 2));
save(`kalshi/events-${series}.json`, { ...events, events: keep });
save(`kalshi/event-${ticker}.json`, await json(`${KALSHI_BASE}/events/${ticker}`));
save(`kalshi/market-${yes}.json`, await json(`${KALSHI_BASE}/markets/${yes}`));
const end = Math.floor(Date.now() / 1000);
const candles = (await json(`${KALSHI_BASE}/series/${series}/markets/${yes}/candlesticks?start_ts=${end - 7 * 86400}&end_ts=${end}&period_interval=60`)) as {
  candlesticks: unknown[];
};
save(`kalshi/candlesticks-${yes}.json`, { ...candles, candlesticks: candles.candlesticks.slice(-48) });

// Polymarket
let slug: string | null = null;
for (const s of polymarketSlugsOf(game)) {
  const r = await fetch(`${GAMMA_BASE}/markets/slug/${s}?include_tag=true`, { headers: UA });
  if (r.ok) {
    slug = s;
    save(`polymarket/market-${s}.json`, await r.json());
    break;
  }
}
if (!slug) throw new Error('no Polymarket market for this game');
const others = keep.slice(1).flatMap((e) => {
  const g = parseKalshiTicker(e.event_ticker);
  return g ? polymarketSlugsOf(g) : [];
});
const multiSlugs = [slug, ...others];
save('polymarket/markets-by-slug.json', await json(`${GAMMA_BASE}/markets?${multiSlugs.map((s) => `slug=${s}`).join('&')}&limit=${multiSlugs.length}`));
const token = (JSON.parse((JSON.parse(readFileSync(join(out, `polymarket/market-${slug}.json`), 'utf8')) as { clobTokenIds: string }).clobTokenIds) as string[])[0]!;
const hist = (await json(`${CLOB_BASE}/prices-history?market=${token}&interval=1w&fidelity=60`)) as { history: unknown[] };
save(`polymarket/prices-history-${slug}.json`, { history: hist.history.slice(-48) });

// Feeds: one RSS club site per team, an Atom blog, a league feed and RotoWire's odd date format.
const feeds: [string, string][] = [
  [`feeds/${game.away.code}.xml`, `https://www.newyorkjets.com/rss/news`],
  [`feeds/${game.home.code}.xml`, `https://www.chiefs.com/rss/news`],
  ['feeds/espn-nfl.xml', 'https://www.espn.com/espn/rss/nfl/news'],
  ['feeds/rotowire-nfl.xml', 'https://www.rotowire.com/rss/news.php?sport=NFL'],
  ['feeds/celticsblog.xml', 'https://www.celticsblog.com/rss/index.xml'],
];
for (const [rel, url] of feeds) {
  const r = await fetch(url, { headers: UA });
  if (r.ok) save(rel, scrubFeed(await r.text()));
}

// Brave: only with the key, and only links, dates and hosts.
const keyFile = process.env.MARKETS_BRAVE_KEY_FILE ?? join(homedir(), '.config/siren/secrets/brave-search');
if (existsSync(keyFile)) {
  const q = `${game.away.name} ${game.home.name} ${game.league.toUpperCase()}`;
  const r = (await json(`${BRAVE_NEWS}?q=${encodeURIComponent(q)}&count=20&freshness=pw&country=us&search_lang=en&spellcheck=0`, {
    'x-subscription-token': readFileSync(keyFile, 'utf8').trim(),
  })) as { type?: string; results?: { url: string; page_age?: string; age?: string; meta_url?: { hostname?: string } }[] };
  save('brave/news-search.json', {
    type: r.type,
    recorded: 'live',
    results: (r.results ?? []).map((x) => ({ url: x.url, page_age: x.page_age, age: x.age, meta_url: { hostname: x.meta_url?.hostname } })),
  });
} else process.stderr.write('brave: no key file, brave/news-search.json left as it is\n');
