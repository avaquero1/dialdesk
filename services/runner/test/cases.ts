import { RUNNER } from '@app/contracts';
import { fakeApp, type Case } from '@app/testkit';
import { DEMO_RUN, fake } from '../src/fake.ts';

export const api = RUNNER;
export const makeApp = () => fakeApp('runner', RUNNER, fake());
export const cases: Case[] = [
  { endpoint: 'getRun', caller: 'board', input: () => ({ params: { run_id: DEMO_RUN.run_id } }) },
  { endpoint: 'getRun', caller: 'board', input: () => ({ params: { run_id: 'run_missing000001' } }), expect: 404 },
];
