import type { RunTraceStep } from '@app/contracts';

/** What the live journey keeps in its record, as pure functions (tests/live-record.test.ts). */

interface BoxRow {
  sandbox_id: string;
  at: string;
}
interface BoxCreated extends BoxRow {
  kind: string;
  job_id: string;
  run_id: string;
  widget_id: string;
}

/** Each compute box's time from audit's `sandbox.created` row to its `sandbox.destroyed` row (the manager's clock). Not destroyed: `finished_at` and `ms` are null. */
export function computeBoxTimes(created: BoxCreated[], destroyed: BoxRow[]) {
  const ends = new Map(destroyed.map((d) => [d.sandbox_id, d.at]));
  return created
    .filter((b) => b.kind === 'compute')
    .map(({ sandbox_id, job_id, run_id, widget_id, at }) => {
      const finished_at = ends.get(sandbox_id) ?? null;
      return { sandbox_id, job_id, run_id, widget_id, created_at: at, finished_at, ms: finished_at === null ? null : Date.parse(finished_at) - Date.parse(at) };
    });
}

/** run.ts writes code@where in a note: a field path or a fact id, never text. */
const VERDICT_REASON = /\b\w+@[^\s,;]+/g;
const QUOTE = /["“”]/;

/** A run's steps for the record: names, statuses and notes, with the verdict's code@where. A note that quotes anything is withheld, so no page text gets in. */
export function failureTrace(steps: RunTraceStep[]) {
  return steps.map((x) => {
    const note = x.note !== null && QUOTE.test(x.note) ? '(withheld: a note that quotes)' : x.note;
    return {
      run_id: x.run_id,
      widget_id: x.widget_id,
      seq: x.seq,
      step: x.step,
      status: x.status,
      at: x.at,
      ms: x.duration_ms,
      domain: x.source?.domain ?? null,
      sandbox: x.sandbox,
      verdict_id: x.verdict_id,
      note,
      verdict: note?.match(VERDICT_REASON) ?? [],
    };
  });
}
