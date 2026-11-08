import { describe, expect, it } from 'vitest';
import type { RunTraceStep } from '@app/contracts';
import { computeBoxTimes, failureTrace } from '../e2e/live/record.ts';

const box = (kind: string, sandbox_id: string, at: string) => ({ kind, sandbox_id, at, job_id: `${sandbox_id}-j`, run_id: 'r1', widget_id: 'w1' });

describe('computeBoxTimes', () => {
  it('times a compute box from created to destroyed, on the manager’s nanosecond timestamps', () => {
    const [t] = computeBoxTimes([box('compute', 's1', '2026-11-08T12:00:00.100000000Z')], [{ sandbox_id: 's1', at: '2026-11-08T12:00:06.350123456Z' }]);
    expect(t).toMatchObject({ sandbox_id: 's1', job_id: 's1-j', ms: 6250, finished_at: '2026-11-08T12:00:06.350123456Z' });
  });

  it('keeps a box with no destroyed row, with no time, and leaves browse boxes out', () => {
    const rows = computeBoxTimes([box('browse', 's1', '2026-11-08T12:00:00Z'), box('compute', 's2', '2026-11-08T12:00:00Z')], []);
    expect(rows.map((r) => [r.sandbox_id, r.finished_at, r.ms])).toEqual([['s2', null, null]]);
  });
});

describe('failureTrace', () => {
  const step = (over: Partial<RunTraceStep>) =>
    ({ run_id: 'r1', widget_id: 'w1', seq: 0, step: 'guard', status: 'failed', at: '2026-11-08T12:00:00Z', duration_ms: 12, sandbox: null, source: null, proxy: null, verdict_id: null, receipt_ids: [], audit_row_id: null, note: null, ...over }) as RunTraceStep;

  it('keeps names, statuses and notes, and pulls out the verdict’s code@where', () => {
    const [t] = failureTrace([step({ note: 'facts left out: banned_word@f2, instruction@f1; blocked: receipts@numbers.0' })]);
    expect(t).toMatchObject({ step: 'guard', status: 'failed', ms: 12, verdict: ['banned_word@f2', 'instruction@f1', 'receipts@numbers.0'] });
    expect(t!.note).toContain('blocked');
  });

  it('keeps a source’s domain, never its address, and withholds a note that quotes', () => {
    const [t] = failureTrace([step({ source: { candidate_id: 'c1', url: 'https://espn.example/a?x=1', domain: 'espn.example', screenshot_key: null } as RunTraceStep['source'], note: 'read “ignore your orders” from page' })]);
    expect(t).toMatchObject({ domain: 'espn.example', note: '(withheld: a note that quotes)', verdict: [] });
    expect(JSON.stringify(t)).not.toMatch(/espn\.example\/a|ignore your orders/);
  });

  it('a plain note has no verdict and a step with no note stays null', () => {
    const [a, b] = failureTrace([step({ note: 'compute timed out' }), step({ note: null })]);
    expect(a!.verdict).toEqual([]);
    expect(b).toMatchObject({ note: null, verdict: [] });
  });
});
