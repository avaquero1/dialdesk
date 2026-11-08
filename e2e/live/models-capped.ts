/**
 * models for `make e2e-live`: the real service on Vultr Serverless Inference with the bake-off's role table, its usage
 * in the step's file (usage.ts), and both caps (global and per account) at most STEP_LIMIT_USD. Before it listens, a
 * cap self-test with no network (the client throws if it is called) must see a call past each cap refused; its result
 * goes to E2E_LIVE_SELFTEST. Otherwise it exits without making a call.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODELS } from '@app/contracts';
import { busFromConfig, createLogger, runService } from '@app/service-kit';
import { fake, fakeDepsFromEnv } from '../../services/models/src/fake.ts';
import { MemoryUsageStore, utcDay, type UsageRow } from '../../services/models/src/meter.ts';
import { real } from '../../services/models/src/real.ts';
import { STEP_LIMIT_USD, StepUsageStore } from './usage.ts';

const usagePath = process.env.E2E_LIVE_USAGE;
const selfTestPath = process.env.E2E_LIVE_SELFTEST;
if (!usagePath || !selfTestPath) throw new Error('e2e-live: set E2E_LIVE_USAGE and E2E_LIVE_SELFTEST');
for (const k of ['MODELS_DAILY_CAP_USD', 'MODELS_ACCOUNT_DAILY_USD'] as const) {
  const v = Number(process.env[k]);
  if (!(v > 0 && v <= STEP_LIMIT_USD)) throw new Error(`e2e-live: ${k} must be above 0 and at most ${STEP_LIMIT_USD}`);
}
const cap = Number(process.env.MODELS_DAILY_CAP_USD);
const acap = Number(process.env.MODELS_ACCOUNT_DAILY_USD);

/** A call past each cap, on a fresh meter with no network: each must be refused with 402. */
export async function capSelfTest(cfg: Record<string, unknown>) {
  const never = async () => {
    throw new Error('the cap self-test reached the network');
  };
  const log = createLogger('models', 'silent');
  const spent = (account: string, usd: number): UsageRow => ({ day: utcDay(new Date()), account, role: 'reader', model: 'mimo-v2.6-flash', calls: 1, input_tokens: 1, output_tokens: 1, cost_usd: usd });
  const body = MODELS.complete.body!.parse({ role: 'summarizer', account_id: 'acc_livecapselftest', messages: [{ role: 'user', content: 'hi' }] });
  const ctx = { caller: 'runner' as const, accountId: null, sessionId: null, log, setHeader: () => {} };
  const out: Record<string, string> = {};
  // Each case lifts the other cap, so the refusal shows the cap under test (an account's spend counts globally too).
  for (const [label, account, usd, caps] of [
    ['global', 'system', cap, { ACCOUNT_DAILY_USD: 9 }],
    ['account', 'acc_livecapselftest', acap, { DAILY_CAP_USD: 9 }],
    ['global_edge', 'system', cap - 0.00001, { ACCOUNT_DAILY_USD: 9 }],
  ] as const) {
    const s = new MemoryUsageStore();
    await s.add(spent(account, usd));
    const h = await real({ ...cfg, ...caps, DATABASE_URL: '' }, { store: s, chat: never, log });
    try {
      await h.complete({ params: {}, query: {}, body }, ctx as never);
      out[label] = 'NOT REFUSED';
    } catch (e) {
      out[label] = `${(e as { status?: number }).status} ${(e as { code?: string }).code}`;
    }
  }
  return out;
}

await runService({
  service: 'models',
  api: MODELS,
  fake: async () => fake(await fakeDepsFromEnv()),
  real: async (cfg) => {
    const st = await capSelfTest(cfg);
    const ok = st.global === '402 kill_switch' && st.account === '402 account_usd_cap' && st.global_edge === '402 kill_switch';
    writeFileSync(selfTestPath, JSON.stringify({ ok, cap_usd: cap, account_cap_usd: acap, ...st }) + '\n');
    if (!ok) throw new Error(`e2e-live: the caps did not refuse (${JSON.stringify(st)}): no real call made`);
    return real(cfg, { bus: busFromConfig('models', cfg), store: new StepUsageStore(usagePath) });
  },
  migrationsDir: fileURLToPath(new URL('../../services/models/migrations', import.meta.url)),
});
