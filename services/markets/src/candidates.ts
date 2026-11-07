import { createHash } from 'node:crypto';
import type { Candidate, SourceRow } from '@app/contracts';

/**
 * Step 0 of a research run, code only: links from the catalog's feeds and from Brave become candidates. A candidate
 * carries its id, link, domain and date. No title goes out (`title_for_user` stays null): web text is data, never
 * instructions, and the planner only ever sees id, domain and date.
 */
export interface Link {
  url: string;
  domain: string;
  published_at: string | null;
  via: Candidate['via'];
}

const bare = (host: string) => host.replace(/^www\./, '');

/** The catalog row for a host: same domain, with or without "www.". */
export function rowFor(rows: SourceRow[], host: string): SourceRow | undefined {
  const h = bare(host.toLowerCase());
  return rows.find((r) => bare(r.domain) === h);
}

/** Stable per link, so every follower and every run sees the same id for the same page. */
export const candidateId = (url: string) => `cnd_${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;

export function parseExtraDomains(s: string | undefined): Set<string> {
  return new Set(
    (s ?? '')
      .split(',')
      .map((d) => bare(d.trim().toLowerCase()))
      .filter((d) => /^[a-z0-9.-]{3,253}$/.test(d)),
  );
}

export function toCandidates(links: Link[], rows: SourceRow[], extra: Set<string>, max = 60): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const sorted = [...links].sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  for (const l of sorted) {
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    const row = rowFor(rows, l.domain);
    out.push({
      candidate_id: candidateId(l.url),
      url: l.url,
      domain: l.domain,
      published_at: l.published_at,
      via: l.via,
      source_id: row?.source_id ?? null,
      allowed: !!row || extra.has(bare(l.domain)),
      title_for_user: null,
    });
    if (out.length >= max) break;
  }
  return out;
}
