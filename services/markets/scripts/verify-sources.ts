/**
 * Checks every production row of the source catalog online, with the same fetcher and parser markets uses: each feed
 * must answer, parse to items, link to the row's own domain, and have an item from the last 14 days. Prints one line
 * per feed (no headlines) and exits 1 when a row fails, so a dead feed is found before a run needs it.
 *
 *   node --import tsx services/markets/scripts/verify-sources.ts
 */
import { PROD_SOURCE_ROWS } from '@app/contracts';
import { rowFor } from '../src/candidates.ts';
import { parseFeed } from '../src/feeds.ts';
import { httpGet } from '../src/upstream.ts';

const get = httpGet();
const MAX_AGE_DAYS = 14;
const feeds = PROD_SOURCE_ROWS.flatMap((row) => row.feeds.map((f) => ({ row, f })));
let failed = 0;

async function check({ row, f }: (typeof feeds)[number]): Promise<string> {
  try {
    const r = await get(f.url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' }, timeoutMs: 15_000 });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const items = parseFeed(r.text);
    if (!items.length) throw new Error('no items');
    const own = items.filter((i) => rowFor([row], i.domain)).length;
    if (own / items.length < 0.5) throw new Error(`only ${own}/${items.length} items link to ${row.domain}`);
    const newest = items.map((i) => i.published_at ?? '').sort().at(-1) || null;
    if (!newest || Date.now() - Date.parse(newest) > MAX_AGE_DAYS * 86400_000) throw new Error(`newest item ${newest ?? 'undated'}`);
    const kind = /<feed[\s>]/.test(r.text.slice(0, 2000)) ? 'atom' : 'rss';
    if (kind !== f.kind) throw new Error(`is ${kind}, catalog says ${f.kind}`);
    return `ok   ${row.source_id.padEnd(22)} ${String(items.length).padStart(3)} items, newest ${newest.slice(0, 10)}  ${f.url}`;
  } catch (err) {
    failed++;
    return `FAIL ${row.source_id.padEnd(22)} ${(err as Error).message}  ${f.url}`;
  }
}

const lines: string[] = [];
for (let i = 0; i < feeds.length; i += 8) lines.push(...(await Promise.all(feeds.slice(i, i + 8).map(check))));
process.stdout.write(lines.join('\n') + `\n${feeds.length - failed}/${feeds.length} feeds ok (${PROD_SOURCE_ROWS.length} rows)\n`);
process.exit(failed ? 1 : 0);
