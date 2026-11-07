import { CONNECTIONS } from '@app/contracts';
import { fakeApp, type Case } from '@app/testkit';
import { fake } from '../src/fake.ts';

export const api = CONNECTIONS;
export const makeApp = () => fakeApp('connections', CONNECTIONS, fake());
const acc = 'acc_contract0001';
const kalshi = (key_id: string) => ({ account_id: acc, exchange: 'kalshi', key_id, key_type: 'ed25519', sealed_key: 'c2VhbGVkLWJveC1ieXRlcy1mb3ItdGVzdHM=', env: 'demo' });
export const cases: Case[] = [
  { endpoint: 'publicKey', caller: 'edge' },
  { endpoint: 'connect', caller: 'edge', input: () => ({ body: kalshi('fixture-key-1') }), save: (o, c) => { c.con = o.connection_id; } },
  { endpoint: 'connect', caller: 'edge', input: () => ({ body: kalshi('fixture-key-write') }), expect: 403, label: 'write scope refused' },
  { endpoint: 'connect', caller: 'edge', input: () => ({ body: { account_id: acc, exchange: 'polymarket', wallet: '0x00000000000000000000000000000000000f1a7e' } }) },
  { endpoint: 'list', caller: 'edge', input: () => ({ query: { account_id: acc } }) },
  { endpoint: 'numbers', caller: 'runner', input: (c) => ({ params: { connection_id: c.con }, query: { account_id: acc } }), expect: 403, label: 'no consent yet' },
  { endpoint: 'setConsent', caller: 'edge', input: (c) => ({ params: { connection_id: c.con }, body: { account_id: acc, share_numbers: true } }) },
  { endpoint: 'numbers', caller: 'runner', input: (c) => ({ params: { connection_id: c.con }, query: { account_id: acc } }) },
  { endpoint: 'remove', caller: 'edge', input: (c) => ({ params: { connection_id: c.con }, query: { account_id: acc } }) },
];
