/**
 * Integration: markets → board first paint. The real markets reads the exchanges' answers recorded this weekend
 * (fixtures/markets/live/weekend, scripts/record-weekend.ts); board asks it for the open games, prescribes the first
 * board from them and paints each display with its prices before any run. Clock pinned to the recording.
 */
import { BOARD, type Board, type DefaultTile } from '@app/contracts';
import { createClient, createLogger } from '@app/service-kit';
import { TEST_TOKENS, fakeApp } from '@app/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WEEKEND, realApp, weekendFetch } from '../../markets/test/recorded.ts';
import { etDate } from '../src/defaults.ts';
import { fake } from '../src/fake.ts';

const AT = Date.parse(WEEKEND.recorded_at);
const today = etDate(AT);
const both = WEEKEND.games.filter((g) => g.polymarket);

function setup() {
  const rec = weekendFetch();
  const markets = realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search' }, { fetch: rec.fetch, now: () => AT, log: createLogger('markets', 'silent') });
  const call = createClient({ baseUrl: 'http://markets.internal', token: TEST_TOKENS.board, fetch: (r) => markets.fetch(r) });
  const board = fakeApp('board', BOARD, fake({ markets: call, enqueue: async () => {} }));
  const edge = createClient({ baseUrl: 'http://board.internal', token: TEST_TOKENS.edge, fetch: (r) => board.fetch(r) });
  return { rec, edge };
}

describe('markets → board: a new board paints this weekend’s games with live prices', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT);
  });
  afterAll(() => vi.useRealTimers());

  it('the recording has NFL and NBA games, most of them on both exchanges', () => {
    expect(WEEKEND.games.some((g) => g.event_key.startsWith('nfl-'))).toBe(true);
    expect(WEEKEND.games.some((g) => g.event_key.startsWith('nba-'))).toBe(true);
    expect(both.length).toBeGreaterThan(WEEKEND.games.length / 2);
  });

  it('first paint: Tonight, the market, Two prices, News, Biggest move and both folders hold recorded games, each with prices', async () => {
    const { rec, edge } = setup();
    const b: Board = await edge(BOARD.createDefaults, { params: { account_id: 'acc_weekend01' }, body: { category: 'sports' } });
    const keys = new Set(WEEKEND.games.map((g) => g.event_key));
    const displays = b.widgets.filter((w) => w.spec.kind === 'display');
    const of = (type: string) => displays.filter((w) => w.spec.kind === 'display' && w.spec.type === type);

    for (const w of displays) {
      if (w.spec.kind !== 'display' || w.spec.type === 'positions') continue;
      // Every game on the board is one the exchanges listed, and every market on it has a price before any run.
      for (const k of w.spec.params.event_keys ?? []) expect(keys.has(k), `${w.spec.title}: ${k}`).toBe(true);
      expect(w.quotes?.map((q) => q.market_id).sort(), w.spec.title).toEqual([...w.spec.market_ids].sort());
      for (const q of w.quotes ?? []) expect(q.yes_price_cents).toBeGreaterThanOrEqual(0);
    }

    const tonight = of('events')[0]!.spec as Extract<DefaultTile, { kind: 'display' }>;
    expect(tonight.title).toBe('Tonight');
    expect(tonight.params.event_keys!.length).toBeGreaterThanOrEqual(4);
    expect(tonight.params.event_keys!.some((k) => k.startsWith('nfl-'))).toBe(true);
    expect(tonight.params.event_keys!.some((k) => k.startsWith('nba-'))).toBe(true);

    // The market and Two prices: one game on both exchanges.
    const gap = of('gap')[0]!.spec as Extract<DefaultTile, { kind: 'display' }>;
    expect(gap.market_ids.map((m: string) => m.split(':')[0])).toEqual(['kalshi', 'polymarket']);

    const folders = b.widgets.filter((w) => w.spec.kind === 'folder');
    expect(folders.map((f) => f.spec.title)).toEqual(['NFL this week', expect.stringMatching(/^NBA /)]);
    const kids = (title: string) => {
      const f = folders.find((x) => x.spec.title === title)!;
      return displays.filter((w) => 'folder_id' in w.spec.place && w.spec.place.folder_id === f.spec.widget_id);
    };
    const nflWeek = WEEKEND.games.filter((g) => g.event_key.startsWith('nfl-') && g.event_key.slice(4, 14) >= today);
    expect(kids('NFL this week').length).toBe(nflWeek.length);
    const nbaFolder = folders[1]!.spec.title;
    const nbaDay = WEEKEND.games.filter((g) => g.event_key.startsWith('nba-') && g.event_key.slice(4, 14) >= today).map((g) => g.event_key.slice(4, 14)).sort()[0];
    expect(kids(nbaFolder).length).toBe(WEEKEND.games.filter((g) => g.event_key.startsWith(`nba-${nbaDay}`)).length);
    for (const c of [...kids('NFL this week'), ...kids(nbaFolder)]) expect(c.quotes?.length, c.spec.title).toBeGreaterThanOrEqual(1);

    // Polite: first paint is one list per league on each exchange, then quotes from the list's cache.
    expect(rec.calls.length).toBeLessThanOrEqual(6);
  });
});
