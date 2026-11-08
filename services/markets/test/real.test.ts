import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MARKETS, PlannerCandidate } from '@app/contracts';
import { runCase, type Case, type Ctx } from '@app/testkit';
import { httpGet } from '../src/upstream.ts';
import { braveClient } from '../src/brave.ts';
import { RECORDED_AT, captureLog, realApp, recordedFetch } from './recorded.ts';

/**
 * The real markets on recorded live answers (fixtures/markets/live), through the service template in real mode:
 * every request and answer is checked against the contract, as `make contracts` does for the fakes.
 */
const KC = 'kalshi:KXNFLGAME-26NOV08NYJKC-KC';
const PM = 'polymarket:nfl-nyj-kc-2026-11-08';
const EV = 'nfl-2026-11-08-nyj-kc';
const SECRET = 'brv-test-key-0123456789-never-printed';

function setup(opts: { braveKey?: boolean } = {}) {
  const rec = recordedFetch();
  const { log, lines } = captureLog();
  const dir = mkdtempSync(join(tmpdir(), 'markets-test-'));
  const keyFile = join(dir, 'brave-search');
  if (opts.braveKey) writeFileSync(keyFile, `${SECRET}\n`);
  const brave = braveClient({ keyFile, get: httpGet(rec.fetch), log, minGapMs: 0 });
  const app = realApp({}, { fetch: rec.fetch, log, brave, now: () => RECORDED_AT });
  return { app, rec, lines, keyFile };
}

async function run<T = never>(app: ReturnType<typeof realApp>, c: Case, ctx: Ctx = {}): Promise<T> {
  const out = await runCase(app, MARKETS, c, ctx);
  expect(out.problems).toEqual([]);
  return out.body as T;
}

describe('markets real mode on recorded live answers', () => {
  it('lists a league: both teams on Kalshi, the moneyline on Polymarket, paired by event key', async () => {
    const { app } = setup();
    const body: { markets: { market_id: string; event_key: string; exchange: string; title: string }[] } = await run(app, {
      endpoint: 'list',
      caller: 'agent',
      input: () => ({ query: { league: 'nfl' } }),
    });
    const game = body.markets.filter((m) => m.event_key === EV);
    expect(game.map((m) => m.market_id).sort()).toEqual([KC, 'kalshi:KXNFLGAME-26NOV08NYJKC-NYJ', PM].sort());
    expect(game.find((m) => m.market_id === KC)?.title).toBe('Jets at Chiefs: Chiefs win');
    expect(game.find((m) => m.market_id === PM)?.title).toBe('Jets at Chiefs: Jets win');
    expect(body.markets.filter((m) => m.exchange === 'polymarket')).toHaveLength(3);
  });

  it('answers the contract cases', async () => {
    const { app } = setup();
    const cases: Case[] = [
      { endpoint: 'get', caller: 'runner', input: () => ({ params: { market_id: KC } }) },
      { endpoint: 'get', caller: 'agent', input: () => ({ params: { market_id: PM } }) },
      { endpoint: 'get', caller: 'agent', input: () => ({ params: { market_id: 'kalshi:NOPE-1' } }), expect: 404 },
      { endpoint: 'get', caller: 'agent', input: () => ({ params: { market_id: 'polymarket:nope-nope' } }), expect: 404 },
      { endpoint: 'history', caller: 'runner', input: () => ({ params: { market_id: KC }, query: { window_s: 7 * 86400 } }) },
      { endpoint: 'history', caller: 'runner', input: () => ({ params: { market_id: PM }, query: { window_s: 86400 } }) },
      { endpoint: 'event', caller: 'runner', input: () => ({ params: { event_key: EV } }) },
      { endpoint: 'event', caller: 'runner', input: () => ({ params: { event_key: 'nfl-2026w10-kc-buf' } }), expect: 404 },
      { endpoint: 'candidates', caller: 'runner', input: () => ({ params: { market_id: KC }, query: {} }) },
      { endpoint: 'candidates', caller: 'agent', input: () => ({ params: { market_id: KC }, query: {} }), expect: 403 },
    ];
    for (const c of cases) await run(app, c);
  });

  it('maps live prices to cents and history to points inside the window', async () => {
    const { app } = setup();
    const m: { yes_price_cents: number; yes_bid_cents: number; yes_ask_cents: number; stale: boolean } = await run(app, {
      endpoint: 'get',
      caller: 'runner',
      input: () => ({ params: { market_id: KC } }),
    });
    expect(m.yes_bid_cents).toBeLessThanOrEqual(m.yes_ask_cents);
    expect(m.stale).toBe(false);
    const h: { points: { t: number; price_cents: number }[] } = await run(app, {
      endpoint: 'history',
      caller: 'runner',
      input: () => ({ params: { market_id: PM }, query: { window_s: 86400 } }),
    });
    expect(h.points.length).toBeGreaterThan(5);
    expect(h.points.every((p) => p.t >= RECORDED_AT / 1000 - 86400)).toBe(true);
  });

  it('pairs an event across exchanges with its kickoff', async () => {
    const { app } = setup();
    const e: { title: string; starts_at: string; markets: { exchange: string }[] } = await run(app, {
      endpoint: 'event',
      caller: 'agent',
      input: () => ({ params: { event_key: EV } }),
    });
    expect(e.title).toBe('Jets at Chiefs');
    expect(e.starts_at).toBe('2026-11-08T18:00:00.000Z');
    expect(e.markets.map((m) => m.exchange).sort()).toEqual(['kalshi', 'kalshi', 'polymarket']);
  });

  it('caches quotes: two reads inside the TTL make one upstream call', async () => {
    const { app, rec } = setup();
    for (let i = 0; i < 3; i++) await run(app, { endpoint: 'get', caller: 'runner', input: () => ({ params: { market_id: KC } }) });
    expect(rec.calls.filter((c) => c.url.includes('/markets/KXNFLGAME-26NOV08NYJKC-KC')).length).toBe(1);
  });

  it('serves the last price as stale when the exchange goes down, and 503 when nothing is cached', async () => {
    let t = RECORDED_AT;
    const rec = recordedFetch();
    const { log } = captureLog();
    const app = realApp({}, { fetch: rec.fetch, log, now: () => t });
    await run(app, { endpoint: 'get', caller: 'runner', input: () => ({ params: { market_id: KC } }) });
    rec.setDown(true);
    t += 60_000;
    const m: { stale: boolean; as_of: string } = await run(app, { endpoint: 'get', caller: 'runner', input: () => ({ params: { market_id: KC } }) });
    expect(m.stale).toBe(true);
    expect(m.as_of).toBe(new Date(RECORDED_AT).toISOString());
    await run(app, { endpoint: 'get', caller: 'runner', input: () => ({ params: { market_id: PM } }), expect: 503 });
  });
});

describe('the games list stays ready (A1.4.10)', () => {
  const NFL: Case = { endpoint: 'list', caller: 'board', input: () => ({ query: { league: 'nfl' } }) };
  type List = { markets: { market_id: string; stale: boolean }[] };
  const ids = (b: List) => b.markets.map((m) => m.market_id).sort();
  const settle = () => new Promise((r) => setTimeout(r, 5));

  function clocked() {
    const rec = recordedFetch();
    const clock = { t: RECORDED_AT };
    const { log } = captureLog();
    const app = realApp({}, { fetch: rec.fetch, log, now: () => clock.t });
    return { app, rec, clock };
  }

  it('an exchange failing after a good list: the same real games, marked stale, for as long as LIST_KEEP_S', async () => {
    const { app, rec, clock } = clocked();
    const good: List = await run(app, NFL);
    expect(good.markets.length).toBeGreaterThan(0);
    expect(good.markets.every((m) => !m.stale)).toBe(true);
    rec.setDown(true);
    clock.t += 3_599_000; // one second inside the default hour
    const kept: List = await run(app, NFL);
    expect(ids(kept)).toEqual(ids(good));
    expect(kept.markets.every((m) => m.stale)).toBe(true);
    await settle();
    clock.t += 2_000; // past the bound, nothing fresher came: the exchanges' answer, a 503
    await run(app, { ...NFL, expect: 503 });
  });

  it('a slow exchange does not hold a read: the last list comes back at once', async () => {
    const rec = recordedFetch();
    let hanging = false;
    const fetch = ((...a: Parameters<typeof rec.fetch>) => (hanging ? new Promise<Response>(() => {}) : rec.fetch(...a))) as typeof rec.fetch;
    let t = RECORDED_AT;
    const app = realApp({}, { fetch, log: captureLog().log, now: () => t });
    const good: List = await run(app, NFL);
    hanging = true;
    t += 31_000;
    const answer = await Promise.race([run<List>(app, NFL), new Promise<'held'>((r) => setTimeout(() => r('held'), 1000))]);
    expect(answer).not.toBe('held');
    expect(ids(answer as List)).toEqual(ids(good));
  });

  it('keepList fills the list before anyone asks, and a read adds no exchange call', async () => {
    const rec = recordedFetch();
    const eventCalls = () => rec.calls.filter((c) => c.url.includes('/events?')).length;
    const app = realApp({}, { fetch: rec.fetch, log: captureLog().log, now: () => RECORDED_AT, keepList: true });
    await vi.waitFor(() => expect(eventCalls()).toBe(2)); // one per league, nobody has asked yet
    const body: List = await run(app, NFL);
    expect(body.markets.length).toBeGreaterThan(0);
    expect(eventCalls()).toBe(2);
  });
});

describe('candidates', () => {
  it('without the Brave key: feeds only, one clear log line, no Brave receipt', async () => {
    const { app, lines, rec } = setup();
    for (let i = 0; i < 2; i++) {
      const c: { receipts: { provider: string }[]; candidates: unknown[] } = await run(app, {
        endpoint: 'candidates',
        caller: 'runner',
        input: () => ({ params: { market_id: KC }, query: {} }),
      });
      expect(c.receipts.map((r) => r.provider)).toEqual(['feeds']);
      expect(c.candidates.length).toBeGreaterThan(5);
    }
    expect(lines.filter((l) => l.includes('brave: no key file'))).toHaveLength(1);
    expect(rec.calls.some((c) => c.url.includes('search.brave.com'))).toBe(false);
  });

  it('with the key: one search per game, shared by both exchanges, the key sent only in its header and never logged', async () => {
    const { app, lines, rec } = setup({ braveKey: true });
    const bodies: string[] = [];
    // The list read also primes each quote (the NYJ market is never fetched on its own).
    await run(app, { endpoint: 'list', caller: 'runner', input: () => ({ query: { league: 'nfl' } }) });
    for (const id of [KC, PM, 'kalshi:KXNFLGAME-26NOV08NYJKC-NYJ']) {
      const out = await runCase(app, MARKETS, { endpoint: 'candidates', caller: 'runner', input: () => ({ params: { market_id: id }, query: {} }) }, {});
      expect(out.problems).toEqual([]);
      bodies.push(JSON.stringify(out.body));
    }
    const searches = rec.calls.filter((c) => c.url.includes('search.brave.com'));
    expect(searches).toHaveLength(1);
    expect(searches[0]!.headers['x-subscription-token']).toBe(SECRET);
    expect(searches[0]!.url).not.toContain(SECRET);
    expect(decodeURIComponent(new URL(searches[0]!.url).searchParams.get('q')!)).toBe('New York Jets Kansas City Chiefs NFL');
    expect([...lines, ...bodies].some((l) => l.includes(SECRET))).toBe(false);
    const c = JSON.parse(bodies[0]!) as { candidates: { url: string; domain: string; allowed: boolean; via: string; source_id: string | null; title_for_user: string | null }[]; receipts: { provider: string; shared_key: string; query: string | null }[] };
    expect(c.receipts.find((r) => r.provider === 'brave')).toMatchObject({ shared_key: `brave:${EV}`, query: 'New York Jets Kansas City Chiefs NFL' });
    // Brave's catalog-domain hit is allowed; the unknown domain is a suggestion; http and javascript: links are dropped.
    const brave = c.candidates.filter((x) => x.via === 'search');
    expect(brave.map((x) => x.domain).sort()).toEqual(['www.chiefs.com', 'www.example-sports-daily.com']);
    expect(brave.find((x) => x.domain === 'www.chiefs.com')).toMatchObject({ allowed: true, source_id: 'src-nfl-kc' });
    expect(brave.find((x) => x.domain === 'www.example-sports-daily.com')).toMatchObject({ allowed: false, source_id: null });
    expect(brave.find((x) => x.domain === 'www.example-sports-daily.com')!.url).not.toContain('utm_');
    // Team feeds come from both clubs; no title goes out.
    expect(new Set(c.candidates.filter((x) => x.via === 'feed').map((x) => x.source_id))).toEqual(new Set(['src-nfl-kc', 'src-nfl-nyj']));
    expect(c.candidates.every((x) => x.title_for_user === null)).toBe(true);
    // What a planner may see of each: id, domain and date (PlannerCandidate is strict: the runner projects to it).
    const all = c.candidates as unknown as { candidate_id: string; domain: string; published_at: string | null }[];
    for (const x of all) expect(PlannerCandidate.safeParse({ candidate_id: x.candidate_id, domain: x.domain, published_at: x.published_at }).success).toBe(true);
    expect(PlannerCandidate.safeParse(c.candidates[0]).success).toBe(false);
  });

  it("allows a domain the user added to the widget", async () => {
    const { app } = setup({ braveKey: true });
    const c: { candidates: { domain: string; allowed: boolean }[] } = await run(app, {
      endpoint: 'candidates',
      caller: 'runner',
      input: () => ({ params: { market_id: KC }, query: { extra_domains: 'example-sports-daily.com' } }),
    });
    expect(c.candidates.find((x) => x.domain === 'www.example-sports-daily.com')?.allowed).toBe(true);
  });

  it('gives the same page the same candidate id for every follower', async () => {
    const a = setup();
    const b = setup();
    const ids = async (s: ReturnType<typeof setup>) =>
      ((await run(s.app, { endpoint: 'candidates', caller: 'runner', input: () => ({ params: { market_id: KC }, query: {} }) })) as { candidates: { candidate_id: string }[] }).candidates.map(
        (x) => x.candidate_id,
      );
    expect(await ids(a)).toEqual(await ids(b));
  });
});
