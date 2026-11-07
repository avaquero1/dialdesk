import { ACCOUNTS } from '@app/contracts';
import { fakeApp, type Case } from '@app/testkit';
import { fake } from '../src/fake.ts';

export const api = ACCOUNTS;
export const makeApp = () => fakeApp('accounts', ACCOUNTS, fake());
const cred = { email: 'sam@example.test', password: 'correct horse battery' };

export const cases: Case[] = [
  { endpoint: 'signup', caller: 'edge', input: () => ({ body: cred }), save: (o, c) => { c.acc = o.account.account_id; c.ses = o.session.session_id; } },
  { endpoint: 'signup', caller: 'edge', input: () => ({ body: cred }), expect: 409, label: 'same email twice' },
  { endpoint: 'guest', caller: 'edge', input: () => ({ body: {} }) },
  { endpoint: 'login', caller: 'edge', input: () => ({ body: cred }) },
  { endpoint: 'login', caller: 'edge', input: () => ({ body: { ...cred, password: 'wrong password!!' } }), expect: 401 },
  { endpoint: 'get', caller: 'edge', input: (c) => ({ params: { account_id: c.acc } }) },
  { endpoint: 'setLook', caller: 'edge', input: (c) => ({ params: { account_id: c.acc }, body: { theme: 'deep-sea', mode: 'dark', hue: 32 } }) },
  { endpoint: 'sessionValid', caller: 'edge', input: (c) => ({ params: { session_id: c.ses } }) },
  { endpoint: 'logout', caller: 'edge', input: (c) => ({ params: { session_id: c.ses } }) },
];
