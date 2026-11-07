import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Logger } from '@app/service-kit';
import { cleanUrl } from './feeds.ts';
import { UpstreamError, type HttpGet } from './upstream.ts';

/**
 * Brave Search (news), one search per market, shared by everyone who follows it. The key is read from a file
 * (MARKETS_BRAVE_KEY_FILE) on each search, so it can be added while the service runs. It is never logged, never
 * returned and never put in an error message. Without the file, search is skipped and that is logged once.
 */
export const BRAVE_NEWS = 'https://api.search.brave.com/res/v1/news/search';

export const BraveNews = z.object({
  type: z.literal('news').optional(),
  results: z
    .array(
      z.object({
        url: z.string(),
        page_age: z.string().optional(),
        age: z.string().optional(),
      }),
    )
    .default([]),
});

export interface SearchHit {
  url: string;
  domain: string;
  published_at: string | null;
}

/** Brave's page_age has no zone ("2026-11-06T18:00:00"): it is UTC. */
function pageAge(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseBrave(body: unknown): SearchHit[] {
  const r = BraveNews.parse(body);
  const out: SearchHit[] = [];
  for (const x of r.results) {
    const c = cleanUrl(x.url);
    if (c && c.url.startsWith('https:')) out.push({ ...c, published_at: pageAge(x.page_age) });
  }
  return out;
}

export interface BraveOpts {
  keyFile: string;
  get: HttpGet;
  log: Logger;
  /** Brave's free plan allows one request a second. */
  minGapMs?: number;
  endpoint?: string;
}

export function braveClient(o: BraveOpts) {
  let warnedMissing = false;
  let announced = false;
  let last = 0;
  let chain: Promise<unknown> = Promise.resolve();

  async function key(): Promise<string | null> {
    try {
      const k = (await readFile(o.keyFile, 'utf8')).trim();
      if (!k) throw new Error('empty');
      if (!announced) {
        o.log.info('brave: key file found, search is on');
        announced = true;
        warnedMissing = false;
      }
      return k;
    } catch {
      if (!warnedMissing) {
        o.log.info({ key_file: o.keyFile }, 'brave: no key file, search skipped until it exists');
        warnedMissing = true;
        announced = false;
      }
      return null;
    }
  }

  /** null = skipped (no key, rate limited or down): the caller goes on with feeds only. */
  async function search(query: string): Promise<SearchHit[] | null> {
    const k = await key();
    if (!k) return null;
    const run = async () => {
      const wait = last + (o.minGapMs ?? 1100) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const url = `${o.endpoint ?? BRAVE_NEWS}?q=${encodeURIComponent(query)}&count=20&freshness=pw&country=us&search_lang=en&spellcheck=0`;
      const r = await o.get(url, { headers: { 'x-subscription-token': k, accept: 'application/json' }, timeoutMs: 8000, maxBytes: 2_000_000 });
      const remaining = r.headers.get('x-ratelimit-remaining');
      if (r.status === 429) {
        o.log.warn({ remaining }, 'brave: rate limited, search skipped');
        return null;
      }
      if (r.status !== 200) throw new UpstreamError('api.search.brave.com', r.status, `api.search.brave.com: status ${r.status}`);
      o.log.info({ remaining }, 'brave: search done');
      return parseBrave(JSON.parse(r.text) as unknown);
    };
    const p = chain.then(run, run);
    chain = p.catch(() => undefined);
    try {
      return await p;
    } catch (err) {
      o.log.warn({ err: (err as Error).message }, 'brave: search failed, skipped');
      return null;
    }
  }

  return { search, hasKey: async () => (await key()) !== null };
}
export type BraveClient = ReturnType<typeof braveClient>;
