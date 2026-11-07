import { AGENT } from '@app/contracts';
import { fakeApp, type Case } from '@app/testkit';
import { fake } from '../src/fake.ts';

export const api = AGENT;
export const makeApp = () => fakeApp('agent', AGENT, fake());
const acc = 'acc_contract0001';
const say = (message: string) => (c: Record<string, unknown>) => ({ body: { account_id: acc, conversation_id: (c.cnv as string) ?? null, widget_id: null, message } });

export const cases: Case[] = [
  { endpoint: 'chat', caller: 'edge', input: say('hi'), save: (o, c) => { c.cnv = o.conversation_id; } },
  { endpoint: 'chat', caller: 'edge', input: say('Chiefs, Bills, and the NBA tonight.') },
  { endpoint: 'chat', caller: 'edge', input: say('should I buy YES on the Chiefs?') },
  { endpoint: 'chat', caller: 'edge', input: say('Make the glass a little warmer.') },
  { endpoint: 'chat', caller: 'edge', input: say('advice-test') },
  { endpoint: 'getConversation', caller: 'edge', input: (c) => ({ params: { conversation_id: c.cnv }, query: { account_id: acc } }) },
];
