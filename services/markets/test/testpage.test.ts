import { describe, expect, it } from 'vitest';
import { MARKETS, type Candidate } from '@app/contracts';
import { runCase } from '@app/testkit';
import { withTestPage } from '../src/testpage.ts';
import { RECORDED_AT, captureLog, realApp, recordedFetch } from './recorded.ts';

const URL_ = 'https://testpage.example.invalid/nfl/week-ten-notes.html';
const KC = 'kalshi:KXNFLGAME-26NOV08NYJKC-KC';
const at = new Date(RECORDED_AT).toISOString();
const live = (n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({ candidate_id: `cnd_${i}`, url: `https://x${i}.test/a`, domain: `x${i}.test`, published_at: null, via: 'feed', source_id: null, allowed: i !== 1, title_for_user: null }) as Candidate);

describe('the test page candidate', () => {
  const game = { event_key: 'nfl-2026-11-08-nyj-kc' };

  it('is off by default: no setting, or half a setting, changes nothing', () => {
    const list = live(5);
    expect(withTestPage(list, game, '', '', at)).toBe(list);
    expect(withTestPage(list, game, URL_, '', at)).toBe(list);
    expect(withTestPage(list, game, '', 'kc', at)).toBe(list);
  });

  it("on: that team's game gets the page first, allowed, beside two live candidates that were allowed", () => {
    const out = withTestPage(live(6), game, URL_, 'kc', at);
    expect(out.map((c) => c.url)).toEqual([URL_, 'https://x0.test/a', 'https://x2.test/a']);
    expect(out[0]).toMatchObject({ domain: 'testpage.example.invalid', allowed: true, source_id: null, via: 'search', published_at: at });
  });

  it("on: every other game, and a market with no game, doesn't get it", () => {
    const list = live(3);
    expect(withTestPage(list, { event_key: 'nfl-2026-11-08-cin-atl' }, URL_, 'kc', at)).toBe(list);
    expect(withTestPage(list, { event_key: null }, URL_, 'kc', at)).toBe(list);
  });

  const candidates = async (cfg: Record<string, unknown>) => {
    const rec = recordedFetch();
    const app = realApp(cfg, { fetch: rec.fetch, log: captureLog().log, now: () => RECORDED_AT });
    await runCase(app, MARKETS, { endpoint: 'list', caller: 'runner', input: () => ({ query: { league: 'nfl' } }) }, {});
    const out = await runCase(app, MARKETS, { endpoint: 'candidates', caller: 'runner', input: () => ({ params: { market_id: KC }, query: {} }) }, {});
    expect(out.problems).toEqual([]);
    return (out.body as { candidates: Candidate[] }).candidates;
  };

  it('through the real markets: the setting decides, default off', async () => {
    expect((await candidates({})).some((c) => c.url === URL_)).toBe(false);
    expect((await candidates({ TESTPAGE_URL: URL_, TESTPAGE_TEAM: 'atl' })).some((c) => c.url === URL_)).toBe(false);
    const on = await candidates({ TESTPAGE_URL: URL_, TESTPAGE_TEAM: 'kc' });
    expect(on[0]!.url).toBe(URL_);
    expect(on).toHaveLength(3);
  });
});
