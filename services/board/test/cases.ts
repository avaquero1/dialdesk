import { BOARD } from '@app/contracts';
import { fakeApp, type Case } from '@app/testkit';
import { fake } from '../src/fake.ts';
import { sampleResult } from '@app/testkit';

export const api = BOARD;
export const makeApp = () => fakeApp('board', BOARD, fake());
const acc = 'acc_contract0001';
const draft = {
  kind: 'display', type: 'gap', title: 'Eagles gap',
  market_ids: ['kalshi:KXNFLGAME-26NOV08PHIDAL-PHI', 'polymarket:nfl-phi-dal-2026-11-08'], params: { event_keys: ['nfl-2026w10-phi-dal'] },
};

export const cases: Case[] = [
  { endpoint: 'createDefaults', caller: 'edge', input: () => ({ params: { account_id: acc }, body: { category: 'sports' } }),
    save: (o, c) => { c.wid = o.widgets.find((w: any) => w.spec.kind === 'display').spec.widget_id; } },
  { endpoint: 'createDefaults', caller: 'edge', input: () => ({ params: { account_id: acc }, body: { category: 'sports' } }), expect: 409 },
  { endpoint: 'getBoard', caller: 'agent', input: () => ({ params: { account_id: acc } }) },
  { endpoint: 'getBoard', caller: 'edge', input: () => ({ params: { account_id: 'acc_nobody000001' } }), expect: 404 },
  { endpoint: 'setLayout', caller: 'edge', input: (c) => ({ params: { account_id: acc }, body: { places: [{ widget_id: c.wid, place: { col: 2, row: 1 } }] } }) },
  { endpoint: 'propose', caller: 'agent', input: () => ({ params: { account_id: acc }, body: { changes: [{ op: 'add', widget: draft }] } }), save: (o, c) => { c.prp = o.proposal_id; } },
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
  { endpoint: 'getReceipt', caller: 'agent', input: () => ({ params: { receipt_id: 'r-0a1b2c3d' }, query: { account_id: acc } }) },
  { endpoint: 'remove', caller: 'edge', input: (c) => ({ params: { widget_id: c.new }, query: { account_id: acc } }) },
];
