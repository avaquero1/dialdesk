/**
 * Records 7 days of price history for every game in fixtures/markets/live/weekend/recorded.json, as the exchanges sent
 * it: Kalshi's hourly candlesticks for the away team's market (the one boards use) and Polymarket's CLOB history for
 * the moneyline's first outcome (the away team), the same requests markets' history makes for a 7-day window.
 * Two requests per game, one every SPACING_MS (polite: public endpoints, no key).
 * The tests of moves and Biggest move read these files with the clock pinned to history.json's time.
 *
 *   node --import tsx services/markets/scripts/record-weekend-history.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { KALSHI_BASE } from '../src/kalshi.ts';
import { CLOB_BASE, PolyMarketRaw, historyInterval } from '../src/polymarket.ts';
import { parseKalshiTicker } from '../src/games.ts';

const weekend = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'markets', 'live', 'weekend');
const out = join(weekend, 'history');
const WINDOW_S = 7 * 86400;
const SPACING_MS = 2500;
const UA = { 'user-agent': 'vultr-hackathon-app-markets/0.1 (+fixture recorder)', accept: 'application/json' };
const recorded = JSON.parse(readFileSync(join(weekend, 'recorded.json'), 'utf8')) as {
  games: { event_key: string; kalshi: string; polymarket: string | null }[];
};
const poly = z.array(PolyMarketRaw).parse(JSON.parse(readFileSync(join(weekend, 'markets-by-slug.json'), 'utf8')));

let calls = 0;
async function json(url: string): Promise<unknown> {
  if (calls++) await sleep(SPACING_MS);
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${new URL(url).hostname}: ${r.status}`);
  return r.json();
}
function save(rel: string, body: unknown) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, rel), JSON.stringify(body) + '\n');
  process.stderr.write(`wrote weekend/history/${rel}\n`);
}

const recordedAt = new Date().toISOString();
const end = Math.floor(Date.parse(recordedAt) / 1000);
const files: { market_id: string; file: string }[] = [];
for (const g of recorded.games) {
  const k = parseKalshiTicker(g.kalshi);
  if (!k) continue;
  const series = g.kalshi.split('-')[0]!;
  const ticker = `${g.kalshi}-${k.away.kalshi}`;
  const q = `start_ts=${end - WINDOW_S}&end_ts=${end}&period_interval=60`;
  save(`kalshi-${ticker}.json`, await json(`${KALSHI_BASE}/series/${series}/markets/${ticker}/candlesticks?${q}`));
  files.push({ market_id: `kalshi:${ticker}`, file: `kalshi-${ticker}.json` });
  const pm = g.polymarket ? poly.find((m) => m.slug === g.polymarket) : undefined;
  const token = pm?.clobTokenIds?.[0];
  if (!pm || !token) continue;
  const { interval, fidelity } = historyInterval(WINDOW_S);
  save(`polymarket-${pm.slug}.json`, await json(`${CLOB_BASE}/prices-history?market=${token}&interval=${interval}&fidelity=${fidelity}`));
  files.push({ market_id: `polymarket:${pm.slug}`, file: `polymarket-${pm.slug}.json` });
}
writeFileSync(join(out, 'history.json'), JSON.stringify({ recorded_at: recordedAt, window_s: WINDOW_S, files }, null, 2) + '\n');
process.stderr.write(`wrote weekend/history/history.json (${files.length} histories, ${calls} requests)\n`);
