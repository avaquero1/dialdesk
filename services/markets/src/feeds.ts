import { Domain } from '@app/contracts';

/**
 * RSS 2.0 and Atom, parsed by code. Feeds are untrusted web content: we keep only each item's link and date (and a
 * lower-cased text used here, by code, to match team names; it never leaves this file's callers). No entity
 * expansion, no DTDs, no external references: we read tags with bounded patterns and decode the five XML entities and
 * numeric references ourselves.
 */
export interface FeedItem {
  url: string;
  domain: string;
  published_at: string | null;
  /** title + summary + categories, lower case, for code-side team matching only. Never sent anywhere. */
  text: string;
}

const MAX_ITEMS = 200;
const MAX_BLOCK = 100_000;

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
const safeChar = (n: number) => (n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '');

const tagText = (block: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decode(m[1]!).trim() : null;
};

function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1]!);
  const attr = (a: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(a);
  const pick = links.find((a) => !attr(a, 'rel') || /alternate/i.test(attr(a, 'rel')![0])) ?? links[0];
  if (!pick) return null;
  const href = attr(pick, 'href');
  return href ? decode(href[2] ?? href[3] ?? '') : null;
}

/** A link we accept: http(s), a real host name, no credentials. Tracking parameters and the fragment are dropped. */
export function cleanUrl(raw: string): { url: string; domain: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const domain = u.hostname.toLowerCase();
  if (!Domain.safeParse(domain).success) return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_)/i.test(k)) u.searchParams.delete(k);
  const url = u.toString();
  return url.length <= 2000 ? { url, domain } : null;
}

export function parseDate(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim().replace(/\s+/g, ' ');
  let d = new Date(t);
  // RotoWire writes "Fri, 06 Nov 2026 2:30:00 PM PST": move the meridiem so the date parser takes it.
  if (Number.isNaN(d.getTime())) {
    const m = /^(.*\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM) ?(.*)$/i.exec(t);
    if (m) {
      const h = (Number(m[2]) % 12) + (m[5]!.toUpperCase() === 'PM' ? 12 : 0);
      d = new Date(`${m[1]} ${String(h).padStart(2, '0')}:${m[3]}:${m[4] ?? '00'} ${m[6]}`.trim());
    }
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseFeed(xml: string): FeedItem[] {
  if (/<!DOCTYPE[^>]*\[/i.test(xml)) return []; // an internal DTD subset: refuse rather than guess
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].slice(0, MAX_ITEMS);
  const out: FeedItem[] = [];
  for (const [, kind, raw] of blocks) {
    const block = raw!.slice(0, MAX_BLOCK);
    const isAtom = kind!.toLowerCase() === 'entry';
    const link =
      (isAtom ? atomLink(block) : tagText(block, 'link')) ||
      tagText(block, 'feedburner:origLink') ||
      (/<guid[^>]*isPermaLink\s*=\s*["']?true/i.test(block) || /<guid[^>]*>\s*https?:/i.test(block) ? tagText(block, 'guid') : null);
    const clean = link ? cleanUrl(link) : null;
    if (!clean) continue;
    const date = tagText(block, 'pubDate') ?? tagText(block, 'published') ?? tagText(block, 'updated') ?? tagText(block, 'dc:date');
    const text = [tagText(block, 'title'), tagText(block, 'description') ?? tagText(block, 'summary'), ...[...block.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => decode(m[1]!)), ...[...block.matchAll(/<category[^>]*term\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!)]
      .filter(Boolean)
      .join(' ')
      .replace(/<[^>]*>/g, ' ')
      .toLowerCase()
      .slice(0, 4000);
    out.push({ ...clean, published_at: parseDate(date), text });
  }
  return out;
}

/** Does this item mention the team by its nickname ("Chiefs", "Trail Blazers")? Code-side matching only. */
export function mentions(text: string, nickname: string): boolean {
  const words = [nickname, ...(nickname.includes(' ') ? [nickname.split(' ').at(-1)!] : [])];
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text));
}
