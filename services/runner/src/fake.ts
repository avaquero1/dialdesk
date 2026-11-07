import { RUNNER, type RunState } from '@app/contracts';
import { HttpError, type Handlers } from '@app/service-kit';

export type FakeDeps = Record<string, never>;
export async function fakeDepsFromEnv(): Promise<FakeDeps> {
  return {};
}

/** A finished demo run, so callers have something to read. */
export const DEMO_RUN: RunState = {
  run_id: 'run_demo00000001',
  job_id: 'wid_demo00000001:numbers:1794096000',
  widget_id: 'wid_demo00000001',
  account_id: 'acc_demo00000001',
  kind: 'numbers',
  status: 'done',
  last_step: 'publish',
  steps: [],
  started_at: '2026-11-07T15:00:00.000Z',
  finished_at: '2026-11-07T15:00:02.000Z',
};

/** In-memory run_state. The fake consumes no queue; e2e/run-on-fakes.ts plays runner's steps on the other fakes. */
export function fake(_deps: FakeDeps = {}, runs = new Map([[DEMO_RUN.run_id, DEMO_RUN]])): Handlers<typeof RUNNER> {
  return {
    getRun: ({ params }) => {
      const r = runs.get(params.run_id);
      if (!r) throw new HttpError(404, 'not_found', 'no such run');
      return r;
    },
  };
}
