import { EDGE, ACCOUNTS, AGENT, AUDIT, BOARD, CONNECTIONS, MODELS } from '@app/contracts';
import { createClient } from '@app/service-kit';
import { fakeApp, sampleResult, TEST_TOKENS, type Case } from '@app/testkit';
import { fake as accounts } from '../../accounts/src/fake.ts';
import { fake as agent } from '../../agent/src/fake.ts';
import { createFakeAudit } from '../../audit/src/fake.ts';
import { fake as board } from '../../board/src/fake.ts';
import { fake as connections } from '../../connections/src/fake.ts';
import { fake as models } from '../../models/src/fake.ts';
import type { Hono } from 'hono';
import { createFakeEdge, inProcess, type FakeDeps } from '../src/fake.ts';

export const api = EDGE;
let boardAsRunner: ReturnType<typeof createClient>;

/** edge on top of the other fakes, in process. */
export function makeApp() {
  return wire((deps) => {
    const e = createFakeEdge(deps);
    return fakeApp('edge', EDGE, e.handlers, e.sessionCheck);
  });
}

/**
 * The upstream fakes, in process, with any accounts app and any edge on top: real.test.ts runs these same cases
 * with the real accounts and the real edge.
 */
export function wire(makeEdge: (deps: FakeDeps) => Hono, accountsApp: Hono = fakeApp('accounts', ACCOUNTS, accounts())) {
  const t = TEST_TOKENS.edge;
  const boardApp = fakeApp('board', BOARD, board());
  boardAsRunner = createClient({ baseUrl: 'http://board.internal', token: TEST_TOKENS.runner, fetch: (r) => boardApp.fetch(r) });
  const agentApp = fakeApp('agent', AGENT, agent({ board: inProcess({ board: boardApp }, { board: TEST_TOKENS.agent }).board }));
  const deps = inProcess(
    {
      accounts: accountsApp,
      board: boardApp,
      agent: agentApp,
      connections: fakeApp('connections', CONNECTIONS, connections()),
      audit: fakeApp('audit', AUDIT, createFakeAudit().handlers),
      models: fakeApp('models', MODELS, models()),
    },
    { accounts: t, board: t, agent: t, connections: t, audit: t, models: t },
  );
  return makeEdge(deps);
}

export const cases: Case[] = [
  { endpoint: 'me', caller: 'browser', expect: 401, label: 'no session' },
  { endpoint: 'guest', caller: 'public', input: () => ({ body: {} }) },
  { endpoint: 'signup', caller: 'public', input: () => ({ body: { email: 'kim@example.test', password: 'correct horse battery' } }) },
  { endpoint: 'login', caller: 'public', input: () => ({ body: { email: 'kim@example.test', password: 'correct horse battery' } }) },
  { endpoint: 'me', caller: 'browser' },
  { endpoint: 'board', caller: 'browser', save: (o, c) => { c.acc = o.account_id; c.wid = o.widgets.find((w: any) => w.spec.kind === 'display' && w.spec.type === 'gap').spec.widget_id; } },
  { endpoint: 'setLayout', caller: 'browser', input: (c) => ({ body: { places: [{ widget_id: c.wid, place: { col: 4, row: 0 } }] } }) },
  { endpoint: 'chat', caller: 'browser', input: () => ({ body: { conversation_id: null, widget_id: null, message: 'Chiefs, Bills, and the NBA tonight.' } }),
    save: (o, c) => { c.prp = o.turn.chips[0].proposal_id; } },
  { endpoint: 'accept', caller: 'browser', input: (c) => ({ params: { proposal_id: c.prp }, body: {} }), save: (o, c) => { c.new = o.widgets[0].spec.widget_id; } },
  { endpoint: 'chat', caller: 'browser', input: () => ({ body: { conversation_id: null, widget_id: null, message: 'NFL too' } }), save: (o, c) => { c.prp2 = o.turn.chips[0].proposal_id; } },
  { endpoint: 'reject', caller: 'browser', input: (c) => ({ params: { proposal_id: c.prp2 }, body: {} }) },
  { endpoint: 'resize', caller: 'browser', input: (c) => ({ params: { widget_id: c.new }, body: { size: 'L' } }) },
  { endpoint: 'addSource', caller: 'browser', input: (c) => ({ params: { widget_id: c.new }, body: { domain: 'weatherdesk.fixture.test' } }) },
  { endpoint: 'clear', caller: 'browser', input: (c) => ({ params: { widget_id: c.new }, body: {} }) },
  { endpoint: 'refresh', caller: 'browser', input: (c) => ({ params: { widget_id: c.new }, body: {} }) },
  { endpoint: 'trace', caller: 'browser', input: (c) => ({ params: { widget_id: c.new } }) },
  { endpoint: 'receipt', caller: 'browser', input: () => ({ params: { receipt_id: 'r-00000000' } }), expect: 404, label: 'not on this board' },
  {
    endpoint: 'receipt',
    caller: 'browser',
    before: async (c) => void (await boardAsRunner(BOARD.putResult, { params: { widget_id: c.new as string }, body: sampleResult(c.new as string, c.acc as string, 'pass') })),
    input: () => ({ params: { receipt_id: 'r-0a1b2c3d' } }),
  },
  { endpoint: 'remove', caller: 'browser', input: (c) => ({ params: { widget_id: c.new } }) },
  { endpoint: 'setLook', caller: 'browser', input: () => ({ body: { theme: 'agent-mail', mode: 'system', hue: 32 } }) },
  { endpoint: 'connectionsKey', caller: 'browser' },
  { endpoint: 'connect', caller: 'browser', input: () => ({ body: { exchange: 'polymarket', wallet: '0x00000000000000000000000000000000000f1a7e' } }), save: (o, c) => { c.con = o.connection_id; } },
  { endpoint: 'connections', caller: 'browser' },
  { endpoint: 'consent', caller: 'browser', input: (c) => ({ params: { connection_id: c.con }, body: { share_numbers: true } }) },
  { endpoint: 'disconnect', caller: 'browser', input: (c) => ({ params: { connection_id: c.con } }) },
  { endpoint: 'trust', caller: 'browser' },
  { endpoint: 'auditHead', caller: 'public' },
  { endpoint: 'auditVerify', caller: 'public' },
  { endpoint: 'logout', caller: 'browser', input: () => ({ body: {} }) },
  { endpoint: 'me', caller: 'browser', expect: 401, label: 'after logout' },
];
