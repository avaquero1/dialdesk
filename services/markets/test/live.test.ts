import { describe, expect, it } from 'vitest';
import { MARKETS } from '@app/contracts';
import { runCase, type Case, type Ctx } from '@app/testkit';
import { captureLog, realApp } from './recorded.ts';

/**
 * The real markets against the live public APIs: Kalshi, Polymarket, the catalog's feeds (and Brave when the key file
 * exists). It needs the network, so the gate skips it. Run it with:
 *
 *   MARKETS_LIVE=1 npx vitest run --project contracts services/markets/test/live.test.ts
 */
describe.skipIf(!process.env.MARKETS_LIVE)('markets real mode, live public APIs', () => {
  it('answers every endpoint inside the contract', { timeout: 120_000 }, async () => {
    const { log, lines } = captureLog();
    const app = realApp({ BRAVE_KEY_FILE: process.env.MARKETS_BRAVE_KEY_FILE }, { log });
    const ctx: Ctx = {};
    type M = { market_id: string; exchange: string; event_key: string | null };
    const cases: Case[] = [
      {
        endpoint: 'list',
        caller: 'agent',
        input: () => ({ query: { league: 'nfl' } }),
        save: (out: { markets: M[] }, c) => {
          const paired = out.markets.find((m) => m.exchange === 'polymarket' && m.event_key)!;
          c.event = paired.event_key;
          c.poly = paired.market_id;
          c.kalshi = out.markets.find((m) => m.exchange === 'kalshi' && m.event_key === paired.event_key)!.market_id;
        },
      },
      { endpoint: 'list', caller: 'runner', input: () => ({ query: { league: 'nba' } }) },
      { endpoint: 'list', caller: 'agent', input: () => ({ query: { q: 'chiefs' } }) },
      { endpoint: 'get', caller: 'runner', input: (c) => ({ params: { market_id: c.kalshi } }) },
      { endpoint: 'get', caller: 'agent', input: (c) => ({ params: { market_id: c.poly } }) },
      { endpoint: 'get', caller: 'agent', input: () => ({ params: { market_id: 'kalshi:NOPE-1' } }), expect: 404 },
      { endpoint: 'history', caller: 'runner', input: (c) => ({ params: { market_id: c.kalshi }, query: { window_s: 7 * 86400 } }) },
      { endpoint: 'history', caller: 'runner', input: (c) => ({ params: { market_id: c.poly }, query: { window_s: 86400 } }) },
      { endpoint: 'event', caller: 'runner', input: (c) => ({ params: { event_key: c.event } }) },
      { endpoint: 'candidates', caller: 'runner', input: (c) => ({ params: { market_id: c.kalshi }, query: {} }) },
      { endpoint: 'candidates', caller: 'runner', input: (c) => ({ params: { market_id: c.poly }, query: {} }) },
    ];
    for (const c of cases) {
      const out = await runCase(app, MARKETS, c, ctx);
      expect(out.problems, `${c.endpoint} ${JSON.stringify(c.input?.(ctx))}`).toEqual([]);
      if (c.endpoint === 'event') expect((out.body as { markets: M[] }).markets.map((m) => m.exchange)).toContain('polymarket');
      if (c.endpoint === 'candidates') expect((out.body as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0);
    }
    expect(lines.filter((l) => l.startsWith('error'))).toEqual([]);
  });
});
