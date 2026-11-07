import { MODELS } from '@app/contracts';
import { fakeApp, type Case } from '@app/testkit';
import { fake } from '../src/fake.ts';

export const api = MODELS;
export const makeApp = () => fakeApp('models', MODELS, fake());
const ask = (role: string, scenario?: string, content = 'hello') => () => ({ body: { role, account_id: null, messages: [{ role: 'user', content }], ...(scenario && { scenario }) } });
export const cases: Case[] = [
  { endpoint: 'complete', caller: 'agent', input: ask('chat') },
  { endpoint: 'complete', caller: 'agent', input: ask('chat', 'advice') },
  { endpoint: 'complete', caller: 'runner', input: ask('planner') },
  { endpoint: 'complete', caller: 'runner', input: ask('reader', 'clean') },
  { endpoint: 'complete', caller: 'runner', input: ask('reader', 'poisoned') },
  { endpoint: 'complete', caller: 'runner', input: ask('summarizer') },
  { endpoint: 'complete', caller: 'runner', input: ask('guard', 'poisoned') },
  { endpoint: 'complete', caller: 'runner', input: ask('reader', 'error'), expect: 502 },
  { endpoint: 'complete', caller: 'runner', input: ask('reader', undefined, '-----BEGIN PRIVATE KEY----- x'), expect: 400, label: 'key in prompt refused' },
  { endpoint: 'spend', caller: 'edge', input: () => ({ query: {} }) },
];
