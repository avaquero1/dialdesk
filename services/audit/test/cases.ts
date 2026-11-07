import { AUDIT } from '@app/contracts';
import { logEntry } from '@app/service-kit';
import { fakeApp, type Case } from '@app/testkit';
import { createFakeAudit } from '../src/fake.ts';

export const api = AUDIT;
const acc = 'acc_contract0001';
export const makeApp = () => {
  const a = createFakeAudit();
  a.append(logEntry('runner', 'sandbox.created', { account_id: acc }));
  a.append(logEntry('runner', 'sandbox.killed', { account_id: acc, outcome: 'killed' }));
  a.append(logEntry('runner', 'proxy.refused', { account_id: acc, outcome: 'refused', sizes: { requests: 2 } }));
  a.append(logEntry('connections', 'connection.scope_checked', { account_id: acc, subject_id: 'con_contract0001', outcome: 'ok', ids: { exchange: 'kalshi', scope: 'read' } }));
  rowId = a.append(logEntry('runner', 'run.poisoned', { account_id: acc, outcome: 'poisoned' })).row_id;
  return fakeApp('audit', AUDIT, a.handlers);
};
let rowId = '';
export const cases: Case[] = [
  { endpoint: 'trust', caller: 'edge', input: () => ({ query: { account_id: acc } }) },
  { endpoint: 'head', caller: 'edge' },
  { endpoint: 'verify', caller: 'edge', input: () => ({ query: {} }) },
  { endpoint: 'row', caller: 'edge', input: () => ({ params: { row_id: rowId }, query: { account_id: acc } }) },
];
