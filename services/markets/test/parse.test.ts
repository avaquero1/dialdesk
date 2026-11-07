import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_CATALOG, SourceCatalog } from '@app/contracts';
import { FIXTURES_DIR } from '@app/testkit';
import { TtlCache } from '../src/cache.ts';
import { cleanUrl, mentions, parseDate, parseFeed } from '../src/feeds.ts';
import { etDate, eventKeyOf, kalshiEventOf, parseEventKey, parseKalshiTicker, parsePolymarketSlug, polymarketSlugsOf } from '../src/games.ts';
import { KalshiCandles, KalshiEventsPage, KalshiMarketOne, kalshiPoints, kalshiToMarket } from '../src/kalshi.ts';
import { PolyMarketRaw, historyInterval, polyToMarket } from '../src/polymarket.ts';
import { TEAMS } from '../src/teams.ts';

const live = (rel: string) => readFileSync(join(FIXTURES_DIR, 'markets', 'live', rel), 'utf8');
const asOf = '2026-11-07T12:40:00.000Z';

describe('games: one name per exchange', () => {
  it('reads Kalshi tickers, including codes that run together', () => {
    const g = parseKalshiTicker('KXNFLGAME-26NOV08NYJKC-KC')!;
    expect([g.league, g.date, g.away.code, g.home.code, g.yes?.code]).toEqual(['nfl', '2026-11-08', 'nyj', 'kc', 'kc']);
    expect(parseKalshiTicker('KXNFLGAME-26NOV08CLENO')?.home.nickname).toBe('Saints');
    expect(parseKalshiTicker('KXNFLGAME-26NOV08GBNE')?.away.nickname).toBe('Packers');
    expect(parseKalshiTicker('KXNBAGAME-26NOV08NOPLAC-LAC')?.yes?.nickname).toBe('Clippers');
    expect(parseKalshiTicker('KXNFLGAME-26NOV08NYJKC-XX')).toBeNull();
    expect(parseKalshiTicker('KXPRES-28-DEM')).toBeNull();
  });

  it('round-trips event keys to both exchanges, Polymarket spelling the Rams and Jaguars its own way', () => {
    const g = parseEventKey('nfl-2026-11-08-lar-was')!;
    expect(kalshiEventOf(g)).toBe('KXNFLGAME-26NOV08LARWAS');
    expect(polymarketSlugsOf(g)).toEqual(['nfl-la-was-2026-11-08', 'nfl-la-was-2026-11-09']);
    expect(eventKeyOf(parsePolymarketSlug('nfl-jax-ten-2026-11-15')!)).toBe('nfl-2026-11-15-jac-ten');
    expect(parsePolymarketSlug('nfl-nyj-kc-2026-11-08-spread-away-1pt5')).toBeNull();
    expect(parseEventKey('nfl-2026w10-kc-buf')).toBeNull(); // the fixtures' made-up keys stay the fake's
  });

  it('keys a night game by its ET day although Polymarket dates the slug by UTC', () => {
    expect(etDate('2026-11-09T01:20:00Z')).toBe('2026-11-08');
    const raw = PolyMarketRaw.parse({
      slug: 'nfl-tb-chi-2026-11-09',
      question: 'Buccaneers vs. Bears',
      outcomes: '["Buccaneers", "Bears"]',
      outcomePrices: '["0.29", "0.71"]',
      gameStartTime: '2026-11-09 01:20:00+00',
    });
    expect(polyToMarket(raw, { asOf })?.event_key).toBe('nfl-2026-11-08-tb-chi');
  });

  it('has 32 NFL and 30 NBA teams with unique codes', () => {
    for (const [l, n] of [['nfl', 32], ['nba', 30]] as const) {
      const t = TEAMS.filter((x) => x.league === l);
      expect(t).toHaveLength(n);
      expect(new Set(t.map((x) => x.code)).size).toBe(n);
      expect(new Set(t.map((x) => x.polymarket)).size).toBe(n);
    }
  });
});

describe('exchange shapes (recorded live, 2026-11-07)', () => {
  it('parses Kalshi markets, events and candles in dollar strings', () => {
    const m = KalshiMarketOne.parse(JSON.parse(live('kalshi/market-KXNFLGAME-26NOV08NYJKC-KC.json'))).market;
    const mk = kalshiToMarket(m, { asOf })!;
    expect(mk).toMatchObject({ market_id: 'kalshi:KXNFLGAME-26NOV08NYJKC-KC', league: 'nfl', category: 'sports', event_key: 'nfl-2026-11-08-nyj-kc' });
    expect(Number.isInteger(mk.yes_price_cents)).toBe(true);
    expect(KalshiEventsPage.parse(JSON.parse(live('kalshi/events-KXNFLGAME.json'))).events.length).toBe(3);
    const pts = kalshiPoints(KalshiCandles.parse(JSON.parse(live('kalshi/candlesticks-KXNFLGAME-26NOV08NYJKC-KC.json'))));
    expect(pts.length).toBeGreaterThan(20);
    expect(pts.every((p) => p.price_cents >= 0 && p.price_cents <= 100)).toBe(true);
  });

  it('fills a candle with no trade from the previous price', () => {
    const c = KalshiCandles.parse({ ticker: 'X', candlesticks: [{ end_period_ts: 1, price: { previous_dollars: '0.8400' } }] });
    expect(kalshiPoints(c)).toEqual([{ t: 1, price_cents: 84 }]);
  });

  it("reads Polymarket's lists-in-strings and takes the first outcome as YES", () => {
    const raw = PolyMarketRaw.parse(JSON.parse(live('polymarket/market-nfl-nyj-kc-2026-11-08.json')));
    expect(raw.outcomes).toEqual(['Jets', 'Chiefs']);
    expect(polyToMarket(raw, { asOf })).toMatchObject({ title: 'Jets at Chiefs: Jets win', league: 'nfl', event_key: 'nfl-2026-11-08-nyj-kc' });
    expect(() => PolyMarketRaw.parse({ ...JSON.parse(live('polymarket/market-nfl-nyj-kc-2026-11-08.json')), outcomes: 'not json' })).toThrow();
  });

  it('picks a history interval the CLOB accepts', () => {
    expect(historyInterval(3600).interval).toBe('6h');
    expect(historyInterval(7 * 86400).interval).toBe('1w');
    expect(historyInterval(30 * 86400).interval).toBe('1m');
  });
});

describe('feeds, parsed by code', () => {
  it('reads RSS club feeds and Atom blogs: link and date only', () => {
    const kc = parseFeed(live('feeds/kc.xml'));
    expect(kc.length).toBe(20);
    expect(kc.every((i) => i.domain === 'www.chiefs.com' && i.published_at)).toBe(true);
    const atom = parseFeed(live('feeds/celticsblog.xml'));
    expect(atom.length).toBe(10);
    expect(atom[0]!.url).toMatch(/^https:\/\/www\.celticsblog\.com\//);
    expect(atom[0]!.published_at).toMatch(/^2026-11-0/);
    expect(parseFeed(live('feeds/espn-nfl.xml')).length).toBe(27); // CDATA links
  });

  it("reads RotoWire's 12-hour dates", () => {
    expect(parseDate('Fri, 06 Nov 2026 2:30:00 PM PST')).toBe('2026-11-06T22:30:00.000Z');
    expect(parseFeed(live('feeds/rotowire-nfl.xml')).every((i) => i.published_at)).toBe(true);
  });

  it('drops links that are not web pages and tracking parameters', () => {
    expect(cleanUrl('javascript:alert(1)')).toBeNull();
    expect(cleanUrl('https://user:pw@example.com/a')).toBeNull();
    expect(cleanUrl('https://169.254.169.254/latest')).toBeNull();
    expect(cleanUrl('https://Example.com/a?utm_source=x&id=2#top')).toEqual({ url: 'https://example.com/a?id=2', domain: 'example.com' });
  });

  it('refuses a DTD and expands no entities but the XML five', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel><item><link>https://e.com/&a;</link></item></channel></rss>';
    expect(parseFeed(bomb)).toEqual([]);
    expect(parseFeed('<rss><item><link>https://e.com/?a=1&amp;b=2</link></item></rss>')[0]!.url).toBe('https://e.com/?a=1&b=2');
  });

  it('matches team nicknames as words', () => {
    expect(mentions('chiefs rule out kelce', 'Chiefs')).toBe(true);
    expect(mentions('mischiefs', 'Chiefs')).toBe(false);
    expect(mentions('blazers win', 'Trail Blazers')).toBe(true);
  });
});

describe('the cache', () => {
  it('shares one fetch between concurrent misses and serves within the TTL', async () => {
    let t = 0;
    let loads = 0;
    const c = new TtlCache(10, () => t);
    const load = async () => ++loads;
    const [a, b] = await Promise.all([c.get('k', 1000, load), c.get('k', 1000, load)]);
    expect([a.value, b.value, loads]).toEqual([1, 1, 1]);
    t = 999;
    expect((await c.get('k', 1000, load)).value).toBe(1);
    t = 1000;
    expect((await c.get('k', 1000, load)).value).toBe(2);
  });

  it('falls back to the last value only for the failures it is told to', async () => {
    let t = 0;
    const c = new TtlCache(10, () => t);
    await c.get('k', 10, async () => 'v1');
    t = 20;
    const r = await c.get('k', 10, async () => Promise.reject(new Error('down')), { staleIf: () => true });
    expect(r).toMatchObject({ value: 'v1', stale: true, at: 0 });
    await expect(c.get('k', 10, async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
  });

  it('stays bounded', async () => {
    const c = new TtlCache(3);
    for (let i = 0; i < 10; i++) await c.get(`k${i}`, 1000, async () => i);
    expect(c.size).toBe(3);
  });
});

describe('the source catalog', () => {
  it('validates, has one feed per team for the NFL and NBA, and every prod row is verified', () => {
    SourceCatalog.parse(SOURCE_CATALOG);
    const prod = SOURCE_CATALOG.rows.filter((r) => r.env === 'prod');
    expect(prod.every((r) => r.verified && r.feeds.length > 0 && r.feeds.every((f) => f.url.startsWith('https://')))).toBe(true);
    for (const l of ['nfl', 'nba'] as const) {
      const teams = new Set(prod.flatMap((r) => r.feeds.filter((f) => f.team && r.leagues.includes(l)).map((f) => f.team)));
      expect([...teams].sort()).toEqual(TEAMS.filter((t) => t.league === l).map((t) => t.code).sort());
    }
    expect(new Set(SOURCE_CATALOG.rows.map((r) => r.source_id)).size).toBe(SOURCE_CATALOG.rows.length);
    expect(new Set(SOURCE_CATALOG.rows.map((r) => r.domain)).size).toBe(SOURCE_CATALOG.rows.length);
  });
});
