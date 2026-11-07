import { newId, type RunTraceStep, type Verdict, type WidgetResult } from '@app/contracts';

const H = 'a'.repeat(64);
const receipt = (id: string, op_id: string, op: 'implied_probability' | 'gap', value: number, unit: 'probability' | 'points', args: Record<string, number>, formula: string) => ({
  id,
  op_id,
  op,
  args,
  formula,
  value,
  unit,
  plan_hash: H,
  input_hash: H,
  engine_version: '0.1.0',
  git_hash: 'unknown',
});

/** A putResult body with engine-shaped numbers and receipts (receipt ids r-0a1b2c3d and r-1b2c3d4e). */
export function sampleResult(widget_id: string, account_id: string, outcome: 'pass' | 'block') {
  const verdict: Verdict = {
    verdict_id: newId('vrd'),
    stage: 'publish',
    outcome,
    reasons: outcome === 'pass' ? [] : [{ code: 'advice', where: 'summary.template' }],
    checker: { wordlist_version: 'v0', model: null },
    at: '2026-11-07T15:00:00.000Z',
  };
  const run_id = newId('run');
  const cnd = newId('cnd');
  const result: WidgetResult = {
    result_id: newId('res'),
    widget_id,
    run_id,
    kind: 'research',
    created_at: '2026-11-07T15:00:02.000Z',
    as_of: '2026-11-07T15:00:00.000Z',
    stale: false,
    numbers: [
      { id: 'n1', op: 'implied_probability', value: 0.61, unit: 'probability', receipt_id: 'r-0a1b2c3d' },
      { id: 'n2', op: 'gap', value: 2, unit: 'points', receipt_id: 'r-1b2c3d4e' },
    ],
    receipts: [
      receipt('r-0a1b2c3d', 'n1', 'implied_probability', 0.61, 'probability', { price_cents: 61 }, 'p = price_cents / 100'),
      receipt('r-1b2c3d4e', 'n2', 'gap', 2, 'points', { a_cents: 61, b_cents: 63 }, 'gap = b_cents - a_cents'),
    ],
    facts: [{ fact_id: 'f1', candidate_id: cnd, claim: 'A starting tackle is questionable.', quote: 'listed as questionable' }],
    summary: {
      template: 'Implied probability {n1}; the exchanges differ by {n2}. {q1}',
      slots: {
        n1: { kind: 'number', number_id: 'n1', receipt_id: 'r-0a1b2c3d', format: 'percent' },
        n2: { kind: 'number', number_id: 'n2', receipt_id: 'r-1b2c3d4e', format: 'points' },
        q1: { kind: 'quote', fact_id: 'f1' },
      },
    },
    sources: [
      { candidate_id: cnd, url: 'https://sportswire.fixture.test/nfl/bills-lt-questionable.html', domain: 'sportswire.fixture.test', outlet: 'Sports Wire', published_at: null, status: 'read' },
    ],
    blocked: [],
    verdict_id: verdict.verdict_id,
  };
  const trace: RunTraceStep[] = [
    {
      run_id,
      widget_id,
      seq: 0,
      step: 'publish',
      status: 'ok',
      at: '2026-11-07T15:00:02.000Z',
      duration_ms: 12,
      sandbox: null,
      source: null,
      proxy: null,
      verdict_id: verdict.verdict_id,
      receipt_ids: ['r-0a1b2c3d', 'r-1b2c3d4e'],
      audit_row_id: null,
      note: null,
    },
  ];
  return { account_id, result, verdict, trace, phase: 'summary' as const };
}
