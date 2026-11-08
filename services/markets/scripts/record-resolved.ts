/**
 * Records this season's settled NFL and NBA game winners on Kalshi, and the candles that price each one before its
 * start: the same requests markets' resolved endpoint makes (one settled list per league, then one batch of candles
 * per game day, dayChunks), one every SPACING_MS (polite: public endpoints, no key). Only the fields markets reads are
 * kept, so the files stay small. Tests of base rates read them (weekendFetch), with the clock at resolved.json's time.
 *
 *   node --import tsx services/markets/scripts/record-resolved.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { KALSHI_BASE, KalshiCandlesBatch, KalshiSettledPage } from '../src/kalshi.ts';
import { dayChunks, settledGames } from '../src/resolved.ts';
import { GAME_SERIES, type GameLeague } from '../src/teams.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'markets', 'live', 'weekend', 'resolved');
const SPACING_MS = 2500;
const UA = { 'user-agent': 'vultr-hackathon-app-markets/0.1 (+fixture recorder)', accept: 'application/json' };

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
  process.stderr.write(`wrote weekend/resolved/${rel}\n`);
}

const recordedAt = new Date().toISOString();
const files: { series: string; tickers: string[]; file: string }[] = [];
for (const league of ['nfl', 'nba'] as GameLeague[]) {
  const series = GAME_SERIES[league];
  // One page of 1000 holds a season so far (checked 2026-11-07: 244 NFL, 400 NBA markets); more pages are an error here.
  const page = KalshiSettledPage.parse(await json(`${KALSHI_BASE}/markets?series_ticker=${series}&status=settled&limit=1000`));
  if (page.cursor) throw new Error(`${series}: more than one page of settled markets; record the next pages too`);
  save(`settled-${series}.json`, { markets: page.markets, cursor: '' });
  const chunks = dayChunks(settledGames(league, page.markets).games);
  for (const [i, c] of chunks.entries()) {
    const tickers = c.games.map((g) => g.ticker);
    const q = `market_tickers=${tickers.join(',')}&start_ts=${c.start}&end_ts=${c.end}&period_interval=60`;
    const got = KalshiCandlesBatch.parse(await json(`${KALSHI_BASE}/markets/candlesticks?${q}`));
    const file = `candles-${series}-${String(i + 1).padStart(3, '0')}.json`;
    save(file, got);
    files.push({ series, tickers, file });
  }
}
writeFileSync(join(out, 'resolved.json'), JSON.stringify({ recorded_at: recordedAt, files }, null, 2) + '\n');
process.stderr.write(`${calls} requests\n`);

// The same records in the engine's history shape ({t, price_cents, outcome}), per league and side, for the engine's
// property tests on real history (engine/tests/recorded_history.rs). A markets test checks it matches the recording.
const { engineHistory } = await import('../src/fake.ts');
writeFileSync(join(out, 'engine-history.json'), JSON.stringify(engineHistory()) + '\n');
process.stderr.write('wrote weekend/resolved/engine-history.json\n');
