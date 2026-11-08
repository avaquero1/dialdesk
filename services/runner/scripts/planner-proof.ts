/**
 * The planner knows the args (roadmap A1.3.5): the real planner (Vultr Serverless Inference, the model the role table
 * picks), asked as Run.plan asks it (PLANNER_PROMPT, plannerInput), twice for each type whose plans go through
 * planProblem, on this weekend's recorded NFL games. Each answer is judged by scripts/planner-judge.ts: does its plan
 * pass the check, and does the engine compute its numbers? Only news has research runs (and so a planner run) today;
 * events, probability and movement are asked too, for the ops they would use.
 *
 * The step is capped (--cap, at most $0.25): the global and the account caps are both set to it, and the usage file
 * counts every row of the step as today's. A cap self-test (no network) runs first. Nothing is retried; the first cap
 * refusal stops the run. Writes <out> (the recorded answers: no key, no headers).
 *
 *   npx tsx --env-file=../../.env scripts/planner-proof.ts --usage <file> --out <file.json> [--cap 0.25] [--reps 2] [--self-test-only]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { MARKETS, MODELS, type Candidate, type Completion } from '@app/contracts';
import { buildApp, createClient, createLogger } from '@app/service-kit';
import { fixtures, testCallers, TEST_TOKENS } from '@app/testkit';
import { MemoryUsageStore, utcDay, type UsageRow, type UsageStore } from '../../models/src/meter.ts';
import { real } from '../../models/src/real.ts';
import { PLANNER_PROMPT, plannerInput } from '../src/run.ts';
import { ENGINE, PLANNED_TYPES, judge, markets, specFor } from './planner-judge.ts';

const STEP_LIMIT = 0.25;
const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const usagePath = arg('usage');
const out = arg('out');
const cap = arg('cap', String(STEP_LIMIT))!;
const reps = Number(arg('reps', '2'));
if (!usagePath || !out) throw new Error('usage: planner-proof.ts --usage <file> --out <file.json> [--cap 0.25] [--reps 2] [--self-test-only]');
if (!(Number(cap) > 0 && Number(cap) <= STEP_LIMIT)) throw new Error(`this step may spend at most $${STEP_LIMIT}`);
if (!existsSync(ENGINE)) throw new Error(`build ${ENGINE} first (make rust)`);

/** The step's usage in a JSON file. Every row counts as today's, so the cap holds for the whole step across UTC days. */
class StepUsageStore implements UsageStore {
  constructor(private path: string) {}
  private all(): UsageRow[] {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as UsageRow[]) : [];
  }
  async load(day: string) {
    return this.all().map((r) => ({ ...r, day }));
  }
  async add(r: UsageRow) {
    const rows = this.all();
    const cur = rows.find((x) => x.account === r.account && x.role === r.role && x.model === r.model);
    if (cur) {
      cur.calls += r.calls;
      cur.input_tokens += r.input_tokens;
      cur.output_tokens += r.output_tokens;
      cur.cost_usd += r.cost_usd;
    } else rows.push({ ...r });
    writeFileSync(this.path, JSON.stringify(rows, null, 2) + '\n');
  }
  total() {
    return this.all().reduce((n, r) => n + r.cost_usd, 0);
  }
}

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('MODELS_')).map(([k, v]) => [k.slice(7), v ?? '']));
for (const k of ['DAILY_CAP_USD', 'ACCOUNT_DAILY_USD'] as const)
  if (!(Number(env[k]) > 0 && Number(env[k]) <= STEP_LIMIT)) throw new Error(`set MODELS_${k} to at most ${STEP_LIMIT} in .env first`);
const capped = { ...env, DAILY_CAP_USD: cap, ACCOUNT_DAILY_USD: cap, ACCOUNT_DAILY_TOKENS: '3000000', ACCOUNT_RPM: '60', DATABASE_URL: '' };
const log = createLogger('planner-proof', 'silent');
const store = new StepUsageStore(usagePath);

// 0. The cap self-test: no network (the client throws if it is ever called).
async function selfTest() {
  const never = async () => {
    throw new Error('the cap self-test reached the network');
  };
  const spent = (account: string, usd: number): UsageRow => ({ day: utcDay(new Date()), account, role: 'reader', model: 'mimo-v2.6-flash', calls: 1, input_tokens: 1, output_tokens: 1, cost_usd: usd });
  const body = MODELS.complete.body!.parse({ role: 'summarizer', account_id: 'acc_planselftest1', messages: [{ role: 'user', content: 'hi' }] });
  const ctx = { caller: 'runner' as const, accountId: null, sessionId: null, log, setHeader: () => {} };
  const results: Record<string, string> = {};
  for (const [label, account, caps, usd] of [
    ['global', 'system', { DAILY_CAP_USD: cap, ACCOUNT_DAILY_USD: '9' }, Number(cap)],
    ['account', 'acc_planselftest1', { DAILY_CAP_USD: '9', ACCOUNT_DAILY_USD: cap }, Number(cap)],
    ['global_edge', 'system', { DAILY_CAP_USD: cap, ACCOUNT_DAILY_USD: '9' }, Number(cap) - 0.00001],
  ] as const) {
    const s = new MemoryUsageStore();
    await s.add(spent(account, usd));
    const h = await real({ ...capped, ...caps }, { store: s, chat: never, log });
    try {
      await h.complete({ params: {}, query: {}, body }, ctx);
      results[label] = 'NOT REFUSED';
    } catch (e) {
      results[label] = `${(e as { status?: number }).status} ${(e as { code?: string }).code}`;
    }
  }
  results.spend_so_far = store.total().toFixed(6);
  return results;
}
const st = await selfTest();
process.stdout.write(`cap self-test: ${JSON.stringify(st)}\n`);
if (st.global !== '402 kill_switch' || st.account !== '402 account_usd_cap' || st.global_edge !== '402 kill_switch') throw new Error('the caps did not refuse: no real call made');
if (process.argv.includes('--self-test-only')) process.exit(0);

const modelsApp = buildApp({ service: 'models', mode: 'real', api: MODELS, handlers: await real(capped, { store, log }), callers: testCallers(), log });
const call = createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS.runner, fetch: (r) => modelsApp.fetch(r) });
const published_at = '2026-11-07T12:00:00Z';
const candidates = fixtures.manifest().map((p, i) => ({ candidate_id: `cand_${i + 1}`, url: p.url, domain: new URL(p.url).hostname, published_at })) as unknown as Candidate[];
const cases: Record<string, unknown>[] = [];
let stopped: string | null = null;
for (const type of PLANNED_TYPES) {
  const spec = await specFor(type);
  const quotes = await Promise.all(spec.market_ids.map((market_id) => markets(MARKETS.get, { params: { market_id } })));
  const input = plannerInput(spec, '', { quotes, candidates });
  for (let rep = 1; rep <= reps && !stopped; rep++) {
    try {
      const o: Completion = await call(MODELS.complete, {
        body: { role: 'planner', account_id: spec.account_id, json: true, messages: [{ role: 'system', content: PLANNER_PROMPT }, { role: 'user', content: JSON.stringify(input) }] },
      });
      const v = await judge(spec, o.content ?? '');
      cases.push({ type, rep, spec, model: o.model, usd: o.usage.cost_usd, content: o.content, verdict: v });
      process.stdout.write(`${type}/${rep}: ${o.model} ${v.problem ?? 'passes'}; ${v.computed} of ${v.ops} op(s) computed\n`);
    } catch (e) {
      const status = (e as { status?: number }).status;
      cases.push({ type, rep, error: `${status ?? ''} ${(e as Error).message}`.slice(0, 200) });
      process.stdout.write(`${type}/${rep}: error ${status ?? ''}\n`);
      if (status === 402) stopped = 'cap';
    }
  }
}
const spent = store.total();
writeFileSync(out, JSON.stringify({ step: 'A1.3.5', recorded_on: utcDay(new Date()), spend: { cap_usd: Number(cap), spent_usd: Number(spent.toFixed(6)), stopped }, cases }, null, 2) + '\n');
process.stdout.write(`spent $${spent.toFixed(6)} of $${cap}; ${cases.filter((c) => (c.verdict as { problem: string | null } | undefined)?.problem === null).length} of ${cases.length} plan(s) pass\n`);
