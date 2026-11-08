/**
 * Results for the board's displays as a real numbers run makes them: runner's own plans (plans.ts) on markets' fake
 * (this weekend's recording: prices, 7-day histories, settled games), all displays in one batch (batch.ts merge, so
 * the receipts carry the b<i>_ prefixes), through the real engine binary (cargo run -p engine), sliced back per widget.
 * The displays tests render what these hold; nothing in them is typed by hand except the unpaired game's sentence,
 * which runner publishes as a result with words and no numbers.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { EngineResult, MARKETS, type EngineInput, type EnginePlan, type WidgetResult, type WidgetSpec } from '@app/contracts';
import { createClient } from '@app/service-kit';
import { TEST_TOKENS, fakeApp, sampleResult } from '@app/testkit';
import { fake as markets } from '../../services/markets/src/fake.ts';
import { merge, slice } from '../../services/runner/src/batch.ts';
import { biggestMoveNumbers, defaultPlan, gapNumbers, isBiggestMove, marketNumbers, pickBiggest, runnablePlan, tonightPlan, type MarketNumbers } from '../../services/runner/src/plans.ts';

type DisplaySpec = Extract<WidgetSpec, { kind: 'display' }>;
const ROOT = join(import.meta.dirname, '../..');
const app = fakeApp('markets', MARKETS, markets());
const call = createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS.runner, fetch: (r) => app.fetch(r) });

/** The engine on one input, as the compute box runs it. */
export function engine(input: EngineInput): EngineResult {
  const out = execFileSync('cargo', ['run', '-q', '-p', 'engine'], { cwd: ROOT, input: JSON.stringify(input), maxBuffer: 32 << 20 });
  return EngineResult.parse(JSON.parse(out.toString()));
}

/** A display's engine input, by runner's own path for its type; or the sentence runner publishes instead. */
async function inputFor(spec: DisplaySpec): Promise<{ input: EngineInput; mn: MarketNumbers } | { words: string } | null> {
  let plan: EnginePlan = defaultPlan(spec);
  let mn: MarketNumbers;
  if (spec.type === 'gap') {
    const g = await gapNumbers(call, spec);
    if ('skip' in g) return { words: g.skip };
    ({ plan, mn } = g);
  } else if (isBiggestMove(spec)) ({ plan, mn } = await biggestMoveNumbers(call, spec));
  else if (spec.type === 'events') {
    plan = tonightPlan(spec);
    mn = await marketNumbers(call, spec, plan);
  } else mn = await marketNumbers(call, spec, plan);
  const p = runnablePlan(plan, mn.numbers);
  if (!p.ops.length) return null;
  return { input: { plan: p, numbers: mn.numbers, origins: mn.origins, ...(mn.provenance ? { provenance: mn.provenance } : {}) }, mn };
}

export interface Made {
  spec: DisplaySpec;
  /** A putResult body: the result and its passing verdict and trace. */
  body: ReturnType<typeof sampleResult>;
}

/** One numbers run for these displays, batched as runner batches a board's runs. */
export async function numbersRun(specs: DisplaySpec[], account_id: string): Promise<Made[]> {
  const parts: { spec: DisplaySpec; input?: EngineInput; mn?: MarketNumbers; words?: string; prefix: string }[] = [];
  for (const [i, spec] of specs.entries()) {
    const x = await inputFor(spec);
    if (x) parts.push({ spec, prefix: `b${i}_`, ...x });
  }
  const computed = parts.filter((p) => p.input);
  const er = engine(merge(computed.map((p) => ({ input: p.input!, prefix: p.prefix }))));
  return parts.map((p) => {
    const body = sampleResult(p.spec.widget_id, account_id, 'pass');
    const r: WidgetResult = body.result;
    Object.assign(r, { kind: 'numbers', facts: [], sources: [], blocked: [], created_at: new Date().toISOString() });
    if (p.words) Object.assign(r, { numbers: [], receipts: [], summary: { template: p.words, slots: {} }, as_of: new Date().toISOString() });
    else {
      let mine = slice(er, p.prefix);
      if (isBiggestMove(p.spec)) mine = pickBiggest(mine) ?? mine;
      Object.assign(r, { numbers: mine.numbers, receipts: mine.receipts, summary: null, as_of: p.mn!.as_of, stale: p.mn!.stale });
      if (p.mn!.notes?.length) r.notes = p.mn!.notes;
    }
    body.trace = body.trace.map((s) => ({ ...s, receipt_ids: r.receipts.map((x) => x.id) }));
    return { spec: p.spec, body };
  });
}
