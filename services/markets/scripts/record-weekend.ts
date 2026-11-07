/**
 * Records this week's open NFL and NBA games from the public APIs into fixtures/markets/live/weekend/, as the exchanges
 * sent them: Kalshi's open game events (both leagues, the next DAYS days by the ticker's ET date) and the Polymarket
 * moneylines for those games, looked up by slug like markets' list does. Four requests in all; no key.
 * The test of markets → board first paint reads these files with the clock pinned to recorded.json's time.
 *
 *   node --import tsx services/markets/scripts/record-weekend.ts [days=3]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KALSHI_BASE } from '../src/kalshi.ts';
import { GAMMA_BASE } from '../src/polymarket.ts';
import { etDate, eventKeyOf, nextDay, parseKalshiTicker, polymarketSlugsOf } from '../src/games.ts';
import { GAME_SERIES } from '../src/teams.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'markets', 'live', 'weekend');
const days = Number(process.argv[2] ?? 3);
const UA = { 'user-agent': 'vultr-hackathon-app-markets/0.1 (+fixture recorder)', accept: 'application/json' };
const recordedAt = new Date().toISOString();
const today = etDate(recordedAt);
let last = today;
for (let i = 1; i < days; i++) last = nextDay(last);

async function json(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${new URL(url).hostname}: ${r.status}`);
  return r.json();
}
function save(rel: string, body: unknown) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, rel), JSON.stringify(body, null, 2) + '\n');
  process.stderr.write(`wrote weekend/${rel}\n`);
}

const games: { event_key: string; kalshi: string; polymarket: string | null }[] = [];
const slugs: string[] = [];
for (const series of Object.values(GAME_SERIES)) {
  const all = (await json(`${KALSHI_BASE}/events?series_ticker=${series}&status=open&limit=200&with_nested_markets=true`)) as {
    events: { event_ticker: string }[];
  };
  const keep = all.events.filter((e) => {
    const g = parseKalshiTicker(e.event_ticker);
    return g && g.date >= today && g.date <= last;
  });
  save(`events-${series}.json`, { ...all, cursor: '', events: keep });
  for (const e of keep) {
    const g = parseKalshiTicker(e.event_ticker)!;
    games.push({ event_key: eventKeyOf(g), kalshi: e.event_ticker, polymarket: null });
    slugs.push(...polymarketSlugsOf(g));
  }
}
const poly = (await json(`${GAMMA_BASE}/markets?${slugs.map((s) => `slug=${s}`).join('&')}&limit=${slugs.length}`)) as { slug: string }[];
save('markets-by-slug.json', poly);
for (const g of games) g.polymarket = poly.find((m) => polymarketSlugsOf(parseKalshiTicker(g.kalshi)!).includes(m.slug))?.slug ?? null;
save('recorded.json', { recorded_at: recordedAt, days: [today, last], games });
