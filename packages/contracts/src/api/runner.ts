import { z } from 'zod';
import { AccountId, RunId, Timestamp, WidgetId } from '../common.ts';
import { api } from '../endpoint.ts';
import { RunKind, RunStepName, RunTraceStep } from '../result.ts';

/** runner's run_state: one row per run, resumed from the last completed step. */
export const RunState = z
  .object({
    run_id: RunId,
    job_id: z.string(),
    widget_id: WidgetId,
    account_id: AccountId,
    kind: RunKind,
    status: z.enum(['running', 'done', 'poisoned', 'failed']),
    last_step: RunStepName.nullable(),
    steps: z.array(RunTraceStep),
    started_at: Timestamp,
    finished_at: Timestamp.nullable(),
  })
  .strict();
export type RunState = z.infer<typeof RunState>;

/** runner's work arrives on the widget-runs queue (bus.ts). Its HTTP API is read-only. */
export const RUNNER = api('runner', {
  getRun: {
    method: 'GET',
    path: '/runs/:run_id',
    callers: ['board'],
    params: z.object({ run_id: RunId }),
    response: RunState,
    errors: [404],
    summary: "A run's state and steps so far.",
  },
});
