import { BOARD, MARKETS, newId } from '@app/contracts';
import { createClient } from '@app/service-kit';
import { fakeApp, sampleResult, TEST_TOKENS, type Case } from '@app/testkit';
import { fake as marketsFake } from '../../markets/src/fake.ts';
import { fake } from '../src/fake.ts';

export const api = BOARD;
/** board as it runs in tests: its first-paint prices come from the markets fake, in process. */
export const marketsForBoard = () => {
  const app = fakeApp('markets', MARKETS, marketsFake());
  return createClient({ baseUrl: 'http://markets.internal', token: TEST_TOKENS.board, fetch: (r) => app.fetch(r) });
};
export const makeApp = () => fakeApp('board', BOARD, fake({ markets: marketsForBoard() }));

/** A 1 x 1 PNG, for the screenshot cases. */
export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const draft = {
  kind: 'display', type: 'gap', title: 'Eagles gap',
  market_ids: ['kalshi:KXNFLGAME-26NOV08PHIDAL-PHI', 'polymarket:nfl-phi-dal-2026-11-08'], params: { event_keys: ['nfl-2026w10-phi-dal'] },
};

/** The contract cases, for one account. The real-mode test runs the same cases with a fresh account id. */
export function makeCases(acc: string): Case[] {
  const run = newId('run');
  const cnd = newId('cnd');
  return [
    { endpoint: 'createDefaults', caller: 'edge', input: () => ({ params: { account_id: acc }, body: { category: 'sports' } }),
      save: (o, c) => { c.wid = o.widgets.find((w: any) => w.spec.kind === 'display').spec.widget_id; } },
    { endpoint: 'createDefaults', caller: 'edge', input: () => ({ params: { account_id: acc }, body: { category: 'sports' } }), expect: 409 },
    { endpoint: 'getBoard', caller: 'agent', input: () => ({ params: { account_id: acc } }) },
    { endpoint: 'getBoard', caller: 'edge', input: () => ({ params: { account_id: 'acc_nobody000001' } }), expect: 404 },
    { endpoint: 'setLayout', caller: 'edge', input: (c) => ({ params: { account_id: acc }, body: { places: [{ widget_id: c.wid, place: { col: 2, row: 1 } }] } }) },
    { endpoint: 'propose', caller: 'agent', input: () => ({ params: { account_id: acc }, body: { changes: [{ op: 'add', widget: draft }] } }), save: (o, c) => { c.prp = o.proposal_id; } },
    { endpoint: 'propose', caller: 'agent', label: 'a param the type does not take', expect: 400,
      input: () => ({ params: { account_id: acc }, body: { changes: [{ op: 'add', widget: { ...draft, params: { team: 'Eagles' } } }] } }) },
    { endpoint: 'accept', caller: 'edge', input: (c) => ({ params: { proposal_id: c.prp }, body: { account_id: acc } }), save: (o, c) => { c.new = o.widgets[0].spec.widget_id; } },
    { endpoint: 'accept', caller: 'edge', input: (c) => ({ params: { proposal_id: c.prp }, body: { account_id: acc } }), expect: 409, label: 'accept twice' },
    { endpoint: 'propose', caller: 'agent', input: () => ({ params: { account_id: acc }, body: { changes: [{ op: 'add', widget: draft }] } }), save: (o, c) => { c.prp2 = o.proposal_id; } },
    { endpoint: 'reject', caller: 'edge', input: (c) => ({ params: { proposal_id: c.prp2 }, body: { account_id: acc } }) },
    { endpoint: 'getWidget', caller: 'runner', input: (c) => ({ params: { widget_id: c.new }, query: { account_id: acc } }) },
    { endpoint: 'resize', caller: 'edge', input: (c) => ({ params: { widget_id: c.new }, body: { account_id: acc, size: 'M' } }) },
    { endpoint: 'resize', caller: 'edge', input: (c) => ({ params: { widget_id: c.new }, body: { account_id: acc, size: 'XL' } }), expect: 400, label: 'size not in catalog' },
    { endpoint: 'addSource', caller: 'edge', input: (c) => ({ params: { widget_id: c.new }, body: { account_id: acc, domain: 'sportswire.fixture.test' } }) },
    { endpoint: 'clear', caller: 'edge', input: (c) => ({ params: { widget_id: c.new }, body: { account_id: acc } }) },
    { endpoint: 'refresh', caller: 'edge', input: (c) => ({ params: { widget_id: c.new }, body: { account_id: acc } }) },
    { endpoint: 'putResult', caller: 'runner', input: (c) => ({ params: { widget_id: c.new }, body: sampleResult(c.new as string, acc, 'pass') }) },
    { endpoint: 'putResult', caller: 'runner', input: (c) => ({ params: { widget_id: c.new }, body: sampleResult(c.new as string, acc, 'block') }), expect: 422, label: 'blocked verdict refused' },
    { endpoint: 'getTrace', caller: 'edge', input: (c) => ({ params: { widget_id: c.new }, query: { account_id: acc } }) },
    { endpoint: 'putScreenshot', caller: 'runner', input: (c) => ({ params: { widget_id: c.new, run_id: run, candidate_id: cnd }, body: { account_id: acc, png_base64: TINY_PNG } }) },
    { endpoint: 'getScreenshot', caller: 'edge', input: (c) => ({ params: { widget_id: c.new, run_id: run, candidate_id: cnd }, query: { account_id: acc } }) },
    { endpoint: 'getScreenshot', caller: 'edge', label: 'no such screenshot', expect: 404,
      input: (c) => ({ params: { widget_id: c.new, run_id: newId('run'), candidate_id: cnd }, query: { account_id: acc } }) },
    { endpoint: 'getReceipt', caller: 'agent', input: () => ({ params: { receipt_id: 'r-0a1b2c3d' }, query: { account_id: acc } }) },
    { endpoint: 'remove', caller: 'edge', input: (c) => ({ params: { widget_id: c.new }, query: { account_id: acc } }) },
  ];
}

export const cases: Case[] = makeCases('acc_contract0001');
