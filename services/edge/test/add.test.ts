/**
 * Integration (W1.2.6): the Add app through edge's routes → board → markets. On the exchanges' answers recorded this
 * weekend (fixtures/markets/live/weekend) a hand-added market card follows one of this week's real games, and "Which game?"
 * lists them; on markets' fake (the catalog's made-up fixture games) Add gives the catalog's draft, as before.
 * Clock pinned to the recording.
 */
import { BOARD, defaultDraft, MARKETS } from '@app/contracts';
import { createClient, createLogger, HttpError } from '@app/service-kit';
import { TEST_TOKENS, fakeApp } from '@app/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WEEKEND, realApp, weekendFetch } from '../../markets/test/recorded.ts';
import { fake as boardFake } from '../../board/src/fake.ts';
import { fake as marketsFake } from '../../markets/src/fake.ts';
import { routes } from '../src/routes.ts';

const AT = Date.parse(WEEKEND.recorded_at);
const acc = 'acc_addgames01';

function edgeOn(markets: { fetch: (r: Request) => Response | Promise<Response> }) {
  const call = createClient({ baseUrl: 'http://markets.internal', token: TEST_TOKENS.board, fetch: (r) => markets.fetch(r) });
  const board = fakeApp('board', BOARD, boardFake({ markets: call, enqueue: async () => {} }));
  const asEdge = createClient({ baseUrl: 'http://board.internal', token: TEST_TOKENS.edge, fetch: (r) => board.fetch(r) });
  const r = routes({ board: asEdge });
  const ctx = { accountId: acc, sessionId: 'ses_addgames01', setHeader: () => {} } as never;
  return {
    signup: () => asEdge(BOARD.createDefaults, { params: { account_id: acc }, body: { category: 'sports' } }),
    choices: (type: 'probability' | 'events' | 'gap') => r.addChoices({ params: { type } } as never, ctx),
    add: async (body: { type: 'probability' | 'events' | 'gap' | 'news'; event_key?: string }) => (await r.addWidget({ body } as never, ctx)).widgets[0]!,
  };
}

describe('edge → board → markets: Add picks this week’s real games', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT);
  });
  afterAll(() => vi.useRealTimers());

  const recorded = () => realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search' }, { fetch: weekendFetch().fetch, now: () => AT, log: createLogger('markets', 'silent') });
  const keys = new Set(WEEKEND.games.map((g) => g.event_key));

  it('on the recorded markets: a market card is a real game, with prices, and "Which game?" lists this week’s games', async () => {
    const e = edgeOn(recorded());
    await e.signup();
    const { choices } = await e.choices('probability');
    expect(choices.length).toBeGreaterThan(3);
    for (const c of choices) {
      expect(keys.has(c.event_key), c.event_key).toBe(true);
      expect(c.label).toMatch(/^.+ at .+, (Mon|Tue|Wed|Thu|Fri|Sat|Sun)( \d{1,2}(:\d\d)? (AM|PM))?$/);
    }

    // The default: the first board's own game (most traded); its markets have prices before any run.
    const first = await e.add({ type: 'probability' });
    expect(first.spec.kind === 'display' && first.spec.params.event_keys?.[0]).toBe(choices[0]!.event_key);
    expect(first.quotes?.length).toBeGreaterThanOrEqual(1);

    // A picked game: the card follows that one.
    const picked = choices[2]!;
    const w = await e.add({ type: 'probability', event_key: picked.event_key });
    if (w.spec.kind !== 'display') throw new Error('not a display');
    expect(w.spec.params.event_keys).toEqual([picked.event_key]);
    expect(w.spec.title).toMatch(/ beat the /);
    expect(w.spec.market_ids).not.toEqual(defaultDraft('probability').market_ids);
    expect(w.quotes?.map((q) => q.market_id).sort()).toEqual([...w.spec.market_ids].sort());

    // Tonight: no question, tonight's real games.
    expect((await e.choices('events')).choices).toEqual([]);
    const tonight = await e.add({ type: 'events' });
    if (tonight.spec.kind !== 'display') throw new Error('not a display');
    expect(tonight.spec.params.event_keys!.length).toBeGreaterThanOrEqual(4);
    for (const k of tonight.spec.params.event_keys!) expect(keys.has(k), k).toBe(true);

    // Not one of this week's games: 404, nothing added.
    await expect(e.add({ type: 'probability', event_key: 'nfl-2026-11-08-zzz-yyy' })).rejects.toMatchObject({ status: 404 } satisfies Partial<HttpError>);
  });

  it('on markets’ fake (only the catalog’s made-up games): the catalog’s draft, and no question', async () => {
    const e = edgeOn(fakeApp('markets', MARKETS, marketsFake()));
    await e.signup();
    expect((await e.choices('probability')).choices).toEqual([]);
    const w = await e.add({ type: 'gap' });
    expect(w.spec).toMatchObject({ kind: 'display', type: 'gap', market_ids: defaultDraft('gap').market_ids, params: defaultDraft('gap').params });
  });
});
