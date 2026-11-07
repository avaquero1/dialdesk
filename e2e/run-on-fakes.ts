/**
 * TEST GLUE, not runner. It plays one widget's research run ("One widget's run" in the architecture) on the fakes
 * and the sandbox-manager stub, so the e2e can pass end to end before runner exists. runner (Phase 2) replaces it;
 * keep the steps in the same order and the e2e keeps meaning the same thing.
 */
import {
  BOARD,
  MARKETS,
  MODELS,
  POISONED_NOTE,
  newId,
  type EngineInput,
  type EngineResult,
  type Fact,
  type RunTraceStep,
  type WidgetResult,
} from '@app/contracts';
import { checkExtract, checkPublish } from '@app/guard';
import { logEntry, type Call, type SandboxClient } from '@app/service-kit';
import { fixtures, pageText } from '@app/testkit';

export interface RunDeps {
  board: Call; // as runner
  markets: Call; // as runner
  models: Call; // as runner
  sandbox: SandboxClient;
  audit: (e: ReturnType<typeof logEntry>) => { row_id: string };
}

export async function researchRun(d: RunDeps, account_id: string, widget_id: string) {
  const run_id = newId('run');
  const trace: RunTraceStep[] = [];
  const step = (s: Partial<RunTraceStep> & Pick<RunTraceStep, 'step' | 'status'>) =>
    trace.push({ run_id, widget_id, seq: trace.length, at: new Date().toISOString(), duration_ms: null, sandbox: null, source: null, proxy: null, verdict_id: null, receipt_ids: [], audit_row_id: null, note: null, ...s });

  // runner never trusts the job: it reloads the spec from board.
  const w = await d.board(BOARD.getWidget, { params: { widget_id }, query: { account_id } });
  if (w.spec.kind !== 'display') throw new Error('not a display');
  const [kalshiId, polyId] = w.spec.market_ids;

  // 0. Sources (code, no model).
  const cands = await d.markets(MARKETS.candidates, { params: { market_id: kalshiId! }, query: {} });
  const allowed = cands.candidates.filter((c) => c.allowed);
  step({ step: 'sources', status: 'ok', note: `${allowed.length} allowed candidates` });

  // 1. Plan: the planner sees ids, domains and dates only.
  const planOut = await d.models(MODELS.complete, {
    body: { role: 'planner', account_id, messages: [{ role: 'user', content: JSON.stringify(allowed.map((c) => ({ id: c.candidate_id, domain: c.domain, date: c.published_at }))) }] },
  });
  const plan = (JSON.parse(planOut.content) as { plan: EngineInput['plan'] }).plan;
  step({ step: 'plan', status: 'ok' });

  // 2-3. Read each source in a held browse sandbox, extract, guard; kill on poison, release when clean.
  const facts: Fact[] = [];
  const sources: WidgetResult['sources'] = [];
  const blocked: WidgetResult['blocked'] = [];
  const killed: string[] = [];
  for (const c of allowed) {
    const job_id = `${run_id}:read:${c.candidate_id}`;
    const job = await d.sandbox.createJob({ job_id, run_id, widget_id, kind: 'browse', browse: { urls: [c.url], allowlist: [c.domain], screenshot: false, hold: true } });
    d.audit(logEntry('sandbox-manager', 'sandbox.created', { account_id, subject_id: job.sandbox_id }));
    step({ step: 'read', status: 'ok', sandbox: { sandbox_id: job.sandbox_id, state: 'held' }, source: { candidate_id: c.candidate_id, url: c.url, domain: c.domain, screenshot_key: null } });
    // PENDING (Phase 1): the stub opens no Chromium, so the page text comes from the fixture file here.
    const page = fixtures.manifest().find((p) => p.url === c.url)!;
    const text = pageText(fixtures.page(page.file));
    const read = await d.models(MODELS.complete, { body: { role: 'reader', account_id, messages: [{ role: 'user', content: text }] } });
    const got: Fact[] = (JSON.parse(read.content) as { facts: { claim: string; quote: string }[] }).facts.map((f, i) => ({
      fact_id: `f${facts.length + i + 1}`,
      candidate_id: c.candidate_id,
      claim: f.claim,
      quote: f.quote,
    }));
    const v = checkExtract(got);
    if (v.outcome === 'poison') {
      const row = d.audit(logEntry('runner', 'run.poisoned', { account_id, subject_id: widget_id, outcome: 'poisoned', ids: { sandbox_id: job.sandbox_id } }));
      const k = await d.sandbox.kill(job_id, 'poison', row.row_id);
      d.audit(logEntry('sandbox-manager', 'sandbox.killed', { account_id, subject_id: k.sandbox_id, outcome: 'killed' }));
      killed.push(job_id);
      blocked.push({ candidate_id: c.candidate_id, domain: c.domain, reason: 'poison', note: POISONED_NOTE, killed_at: k.updated_at, audit_row_id: row.row_id });
      sources.push({ candidate_id: c.candidate_id, url: c.url, domain: c.domain, outlet: null, published_at: c.published_at, status: 'blocked' });
      step({ step: 'extract', status: 'poisoned', sandbox: { sandbox_id: k.sandbox_id, state: 'killed' }, verdict_id: v.verdict_id, audit_row_id: row.row_id, note: POISONED_NOTE });
    } else {
      await d.sandbox.release(job_id);
      d.audit(logEntry('sandbox-manager', 'sandbox.destroyed', { account_id, subject_id: job.sandbox_id }));
      facts.push(...got);
      sources.push({ candidate_id: c.candidate_id, url: c.url, domain: c.domain, outlet: null, published_at: c.published_at, status: 'read' });
      step({ step: 'extract', status: 'ok', sandbox: { sandbox_id: job.sandbox_id, state: 'released' }, verdict_id: v.verdict_id });
    }
  }

  // 4. Math in a compute sandbox, numbers from markets only.
  const k = await d.markets(MARKETS.get, { params: { market_id: kalshiId! } });
  const p = await d.markets(MARKETS.get, { params: { market_id: polyId! } });
  const engine_input: EngineInput = { plan, numbers: { kalshi_price: k.yes_price_cents, polymarket_price: p.yes_price_cents } };
  let math = await d.sandbox.createJob({ job_id: `${run_id}:math`, run_id, widget_id, kind: 'compute', compute: { engine_input } });
  for (let i = 0; i < 50 && !['done', 'failed', 'killed'].includes(math.state); i++) {
    await new Promise((r) => setTimeout(r, 50));
    math = await d.sandbox.getJob(math.job_id);
  }
  if (math.state !== 'done') throw new Error(`compute job ended ${math.state}: ${math.error ?? math.kill_reason}`);
  const er = math.compute_result as EngineResult;
  step({ step: 'math', status: er.ok ? 'ok' : 'failed', receipt_ids: er.receipts.map((r) => r.id) });

  // 5. Summary: words with slots, filled only by engine numbers and fact quotes.
  const sum = await d.models(MODELS.complete, { body: { role: 'summarizer', account_id, messages: [{ role: 'user', content: 'n1 n2 q1' }] } });
  const template = (JSON.parse(sum.content) as { template: string }).template;
  const n = (id: string) => er.numbers.find((x) => x.id === id)!;
  const summary = facts.length
    ? {
        template,
        slots: {
          n1: { kind: 'number' as const, number_id: 'n1', receipt_id: n('n1').receipt_id, format: 'percent' as const },
          n2: { kind: 'number' as const, number_id: 'n2', receipt_id: n('n2').receipt_id, format: 'points' as const },
          q1: { kind: 'quote' as const, fact_id: facts[0]!.fact_id },
        },
      }
    : null;
  step({ step: 'summary', status: summary ? 'ok' : 'skipped' });

  // 6. Guard, 7. publish.
  const draft = { summary, facts, receipts: er.receipts, numbers: er.numbers, sources };
  const verdict = checkPublish(draft);
  step({ step: 'guard', status: verdict.outcome === 'pass' ? 'ok' : 'failed', verdict_id: verdict.verdict_id });
  const result: WidgetResult = {
    result_id: newId('res'),
    widget_id,
    run_id,
    kind: 'research',
    created_at: new Date().toISOString(),
    as_of: k.as_of,
    stale: k.stale || p.stale,
    ...draft,
    blocked,
    verdict_id: verdict.verdict_id,
  };
  step({ step: 'publish', status: 'ok' });
  const put = await d.board(BOARD.putResult, { params: { widget_id }, body: { account_id, result, verdict, trace, phase: 'summary' } });
  return { run_id, result_id: put.result_id, verdict, killed, result };
}
