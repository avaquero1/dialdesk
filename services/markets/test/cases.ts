import { MARKETS } from '@app/contracts';
import { fakeApp, type Case } from '@app/testkit';
import { fake } from '../src/fake.ts';

export const api = MARKETS;
export const makeApp = () => fakeApp('markets', MARKETS, fake());
const kc = 'kalshi:KXNFLGAME-26NOV08KCBUF-KC';
export const cases: Case[] = [
  { endpoint: 'list', caller: 'agent', input: () => ({ query: { league: 'nfl' } }) },
  { endpoint: 'get', caller: 'runner', input: () => ({ params: { market_id: kc } }) },
  { endpoint: 'get', caller: 'agent', input: () => ({ params: { market_id: 'polymarket:nfl-kc-buf-2026-11-08' } }) },
  { endpoint: 'get', caller: 'agent', input: () => ({ params: { market_id: 'kalshi:NOPE-1' } }), expect: 404 },
  { endpoint: 'history', caller: 'runner', input: () => ({ params: { market_id: kc }, query: { window_s: 7 * 86400 } }) },
  { endpoint: 'event', caller: 'runner', input: () => ({ params: { event_key: 'nfl-2026w10-kc-buf' } }) },
  { endpoint: 'candidates', caller: 'runner', input: () => ({ params: { market_id: kc }, query: {} }) },
];
