/**
 * The summarizer speaks plain words (roadmap A1.3.7): the real summarizer (Vultr Serverless Inference, the model the
 * role table picks), asked as Run.summary asks it (SUMMARIZER_PROMPT, summarizerInput), on one News input: the default
 * plan's numbers on this weekend's recorded game, and two facts from the fixture site's pages. Each answer's template is
 * counted before the backstop (BANNED_WORDS) and after it (plainTemplate).
 *
 * The step is capped (--cap, at most $0.05): the global and the account caps are both set to it, and the usage file
 * counts every row of the step as today's. A cap self-test (no network) runs first. Nothing is retried; the first cap
 * refusal stops the run. Writes <out> (the recorded answers: no key, no headers).
 *
 *   MODELS_DAILY_CAP_USD=0.05 MODELS_ACCOUNT_DAILY_USD=0.05 npx tsx --env-file=../../.env scripts/summary-words-proof.ts \
 *     --usage <file> --out <file.json> [--cap 0.05] [--reps 6] [--self-test-only]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { EngineResult, MODELS, type Completion } from '@app/contracts';
import { buildApp, createClient, createLogger } from '@app/service-kit';
import { testCallers, TEST_TOKENS } from '@app/testkit';
import { StepUsageStore } from '../../../e2e/live/usage.ts';
import { MemoryUsageStore, utcDay, type UsageRow } from '../../models/src/meter.ts';
import { real } from '../../models/src/real.ts';
import { defaultPlan, marketNumbers, runnablePlan } from '../src/plans.ts';
import { BANNED_WORDS, SUMMARIZER_PROMPT, jsonOf, plainTemplate, summarizerInput } from '../src/run.ts';
import { ENGINE, markets, specFor } from './planner-judge.ts';

const STEP_LIMIT = 0.05;
const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const usagePath = arg('usage');
const out = arg('out');
const cap = arg('cap', String(STEP_LIMIT))!;
const reps = Number(arg('reps', '6'));
if (!usagePath || !out) throw new Error('usage: summary-words-proof.ts --usage <file> --out <file.json> [--cap 0.05] [--reps 6] [--self-test-only]');
if (!(Number(cap) > 0 && Number(cap) <= STEP_LIMIT)) throw new Error(`this step may spend at most $${STEP_LIMIT}`);
if (!existsSync(ENGINE)) throw new Error(`build ${ENGINE} first (make rust)`);

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('MODELS_')).map(([k, v]) => [k.slice(7), v ?? '']));
for (const k of ['DAILY_CAP_USD', 'ACCOUNT_DAILY_USD'] as const)
  if (!(Number(env[k]) > 0 && Number(env[k]) <= STEP_LIMIT)) throw new Error(`set MODELS_${k} to at most ${STEP_LIMIT} first`);
const capped = { ...env, DAILY_CAP_USD: cap, ACCOUNT_DAILY_USD: cap, ACCOUNT_DAILY_TOKENS: '3000000', ACCOUNT_RPM: '60', DATABASE_URL: '' };
const log = createLogger('summary-words-proof', 'silent');
const store = new StepUsageStore(usagePath);

// 0. The cap self-test: no network (the client throws if it is ever called).
async function selfTest() {
  const never = async () => {
    throw new Error('the cap self-test reached the network');
  };
  const spent = (account: string, usd: number): UsageRow => ({ day: utcDay(new Date()), account, role: 'summarizer', model: 'mimo-v2.6-flash', calls: 1, input_tokens: 1, output_tokens: 1, cost_usd: usd });
  const body = MODELS.complete.body!.parse({ role: 'summarizer', account_id: 'acc_wordselftest1', messages: [{ role: 'user', content: 'hi' }] });
  const ctx = { caller: 'runner' as const, accountId: null, sessionId: null, log, setHeader: () => {} };
  const results: Record<string, string> = {};
  for (const [label, account, caps, usd] of [
    ['global', 'system', { DAILY_CAP_USD: cap, ACCOUNT_DAILY_USD: '9' }, Number(cap)],
    ['account', 'acc_wordselftest1', { DAILY_CAP_USD: '9', ACCOUNT_DAILY_USD: cap }, Number(cap)],
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
  return results;
}
const st = await selfTest();
process.stdout.write(`cap self-test: ${JSON.stringify(st)}\n`);
if (st.global !== '402 kill_switch' || st.account !== '402 account_usd_cap' || st.global_edge !== '402 kill_switch') throw new Error('the caps did not refuse: no real call made');
if (process.argv.includes('--self-test-only')) process.exit(0);

// The News input: the default plan's numbers on this weekend's recorded game, and two facts from the fixture site.
const spec = await specFor('news');
const plan = defaultPlan(spec);
const mn = await marketNumbers(markets, spec, plan);
const r = spawnSync(ENGINE, [], { input: JSON.stringify({ plan: runnablePlan(plan, mn.numbers), numbers: mn.numbers, origins: mn.origins, provenance: mn.provenance }), encoding: 'utf8' });
if (r.status !== 0) throw new Error('the engine did not run the default plan');
const facts = [
  { claim: "The Bills' starting left tackle is listed questionable with a knee injury.", quote: 'listed their starting left tackle as questionable' },
  { claim: 'Strong west winds are expected at kickoff in Orchard Park.', quote: 'steady west winds of about 18 mph' },
];
const input = summarizerInput(facts, EngineResult.parse(JSON.parse(r.stdout)));

const modelsApp = buildApp({ service: 'models', mode: 'real', api: MODELS, handlers: await real(capped, { store, log }), callers: testCallers(), log });
const call = createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS.runner, fetch: (q) => modelsApp.fetch(q) });
const answers: Record<string, unknown>[] = [];
let stopped: string | null = null;
for (let rep = 1; rep <= reps && !stopped; rep++) {
  try {
    const o: Completion = await call(MODELS.complete, {
      body: { role: 'summarizer', account_id: spec.account_id, json: true, messages: [{ role: 'system', content: SUMMARIZER_PROMPT }, { role: 'user', content: JSON.stringify(input) }] },
    });
    const template = (jsonOf(o.content ?? '') as { template?: unknown } | null)?.template;
    const banned = typeof template === 'string' ? (template.match(BANNED_WORDS)?.[0] ?? null) : null;
    const kept = typeof template === 'string' && plainTemplate(template) !== null;
    answers.push({ rep, model: o.model, usd: o.usage.cost_usd, content: o.content, banned });
    process.stdout.write(`${rep}: ${o.model} banned=${banned ?? 'none'} kept=${kept}\n`);
  } catch (e) {
    const status = (e as { status?: number }).status;
    answers.push({ rep, error: `${status ?? ''} ${(e as Error).message}`.slice(0, 200) });
    process.stdout.write(`${rep}: error ${status ?? ''}\n`);
    if (status === 402) stopped = 'cap';
  }
}
const spent = store.total();
const held = answers.filter((a) => a.banned).length;
writeFileSync(out, JSON.stringify({ step: 'A1.3.7', recorded_on: utcDay(new Date()), spend: { cap_usd: Number(cap), spent_usd: Number(spent.toFixed(6)), stopped }, held_banned_word: held, prompt: SUMMARIZER_PROMPT, input, answers }, null, 2) + '\n');
process.stdout.write(`spent $${spent.toFixed(6)} of $${cap}; ${held} of ${answers.length} answers hold a banned word before the backstop\n`);
