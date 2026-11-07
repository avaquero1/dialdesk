import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { z } from 'zod';
import { MODELS, type CompleteBody, type ModelRole } from '@app/contracts';
import { createLogger, HttpError, logEntry, type Bus, type Handlers, type Logger } from '@app/service-kit';
import { KeyGuard } from './keyguard.ts';
import { CapError, DEFAULT_CAPS, MemoryUsageStore, Meter, PgUsageStore, type UsageStore } from './meter.ts';
import { costUsd, PRICES } from './prices.ts';
import { rolesFromEnv } from './roles.ts';
import { createVultrClient, UpstreamError, type VultrChat } from './vultr.ts';

/** models' own config (MODELS_*), on top of the template's. */
export const ModelsConfig = z.object({
  /** The Vultr Inference key, one line. Checked on each call until found, so it can appear after start. */
  VULTR_KEY_FILE: z.string().default('/run/secrets/vultr-inference'),
  VULTR_BASE_URL: z.string().url().default('https://api.vultrinference.com/v1'),
  TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  DAILY_CAP_USD: z.coerce.number().min(0).default(DEFAULT_CAPS.daily_usd),
  ACCOUNT_DAILY_USD: z.coerce.number().min(0).default(DEFAULT_CAPS.account_daily_usd),
  ACCOUNT_DAILY_TOKENS: z.coerce.number().int().min(0).default(DEFAULT_CAPS.account_daily_tokens),
  ACCOUNT_RPM: z.coerce.number().int().min(1).default(DEFAULT_CAPS.account_rpm),
  KILL: z
    .enum(['0', '1', ''])
    .default('')
    .transform((v) => v === '1'),
  /** Fingerprint files of other keys to refuse (comma-separated paths), made with `npm run fingerprint`. */
  KEY_FINGERPRINTS: z.string().default(''),
  DATABASE_URL: z.string().optional(),
});

export interface RealDeps {
  /** Replaces the HTTP client (tests). */
  chat?: VultrChat;
  fetch?: typeof fetch;
  store?: UsageStore;
  bus?: Bus;
  clock?: () => Date;
  log?: Logger;
}

const expandHome = (p: string) => (p.startsWith('~/') ? homedir() + p.slice(1) : p);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Rough token count, on the high side (2.5 characters a token, plus a little per message). */
export const estimateTokens = (b: Pick<CompleteBody, 'messages' | 'tools'>) =>
  Math.ceil(b.messages.reduce((n, m) => n + m.content.length + 16, 0) / 2.5) + (b.tools ? Math.ceil(JSON.stringify(b.tools).length / 2.5) : 0);

/** The key file, read when needed and again when it changes. The key leaves this closure only for the auth header. */
function keyFile(path: string, guard: KeyGuard, log: Logger) {
  let key: string | null = null;
  let seen = '';
  return () => {
    let st;
    try {
      st = statSync(path);
    } catch {
      return null;
    }
    const tag = `${st.mtimeMs}:${st.size}`;
    if (tag !== seen) {
      seen = tag;
      key = readFileSync(path, 'utf8').trim() || null;
      if (key) guard.addKey('vultr-inference', key);
      if (st.mode & 0o077) log.warn({ file: path }, 'the key file is readable by group or others');
      log.info({ file: path, present: Boolean(key) }, 'key file loaded');
    }
    return key;
  };
}

/** The real models: Vultr Serverless Inference behind the key check, caps and metering. */
export async function real(cfg: Record<string, unknown> = {}, deps: RealDeps = {}): Promise<Handlers<typeof MODELS>> {
  // a blank variable means its default
  const c = ModelsConfig.passthrough().parse(Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== '')));
  const log = deps.log ?? createLogger('models');
  const roles = rolesFromEnv(cfg as Record<string, string | undefined>);
  for (const [role, spec] of Object.entries(roles))
    for (const m of spec.models) if (!PRICES[m]) throw new Error(`models: role ${role} uses ${m}, which has no price (src/prices.ts)`);

  const guard = new KeyGuard();
  for (const f of c.KEY_FINGERPRINTS.split(',').map((s) => s.trim()).filter(Boolean)) guard.addFingerprintFile(expandHome(f));
  const key = keyFile(expandHome(c.VULTR_KEY_FILE), guard, log);
  key(); // fingerprint the key now when it is there
  const chat = deps.chat ?? createVultrClient({ baseUrl: c.VULTR_BASE_URL.replace(/\/$/, ''), key, timeoutMs: c.TIMEOUT_MS, fetch: deps.fetch });

  let store = deps.store;
  if (!store) {
    if (c.DATABASE_URL) store = new PgUsageStore(c.DATABASE_URL);
    else {
      log.warn('no DATABASE_URL: usage is kept in memory and lost on restart');
      store = new MemoryUsageStore();
    }
  }
  const meter = new Meter(
    { daily_usd: c.DAILY_CAP_USD, account_daily_usd: c.ACCOUNT_DAILY_USD, account_daily_tokens: c.ACCOUNT_DAILY_TOKENS, account_rpm: c.ACCOUNT_RPM, kill: c.KILL },
    store,
    deps.clock,
  );
  await meter.open();
  log.info({ keys_checked: guard.keys, caps: meter.caps }, 'models ready');

  type Outcome = { model?: string; reason?: string; in?: number; out?: number; usd?: number };
  const audit = async (body: CompleteBody, outcome: 'ok' | 'refused' | 'failed', x: Outcome) => {
    if (!deps.bus) return;
    await deps.bus
      .log(
        logEntry('models', 'model.call', {
          account_id: body.account_id,
          outcome,
          ids: { role: body.role, ...(x.model && { model: x.model }), ...(x.reason && { reason: x.reason }) },
          hashes: { prompt: sha256(JSON.stringify(body.messages)) },
          sizes: { input_tokens: x.in ?? 0, output_tokens: x.out ?? 0, cost_microusd: Math.round((x.usd ?? 0) * 1e6) },
        }),
      )
      .catch((e: Error) => log.error({ err: e.message }, 'audit log failed'));
  };

  return {
    complete: async ({ body }, ctx) => {
      const role: ModelRole = body.role;
      const spec = roles[role];
      if (body.tools?.length && !spec.tools) throw new HttpError(400, 'tools_not_allowed', `the ${role} role takes no tools`);

      // 1. No key ever reaches a model.
      if (body.messages.some((m) => guard.holdsKey(m.content)) || (body.tools && guard.holdsKey(JSON.stringify(body.tools)))) {
        ctx.log.warn({ role, account_id: body.account_id }, 'refused: the prompt holds a key');
        await audit(body, 'refused', { reason: 'key_in_prompt' });
        throw new HttpError(400, 'key_in_prompt', 'a prompt may never contain a key');
      }

      // 2. Reserve the worst case against the caps.
      const max_tokens = body.max_tokens ?? spec.max_tokens;
      const inEst = estimateTokens(body);
      const worstUsd = Math.max(...spec.models.map((m) => costUsd(m, inEst, max_tokens)));
      let held;
      try {
        held = await meter.reserve(body.account_id, { usd: worstUsd, tokens: inEst + max_tokens });
      } catch (e) {
        if (!(e instanceof CapError)) throw e;
        ctx.log.warn({ role, account_id: body.account_id, reason: e.reason }, 'refused: cap');
        await audit(body, 'refused', { reason: e.reason });
        if (e.reason === 'rate_limited') throw new HttpError(429, 'rate_limited', 'too many model calls this minute');
        throw new HttpError(402, e.reason, e.reason === 'kill_switch' ? "today's model budget is spent" : 'a spending cap is reached');
      }

      // 3. The role's models in order until one answers.
      let last: UpstreamError | null = null;
      for (const [attempt, model] of spec.models.entries()) {
        const started = performance.now();
        try {
          const a = await chat({ model, messages: body.messages, tools: body.tools, json: body.json, max_tokens, temperature: spec.temperature, reasoning_effort: spec.reasoning_effort });
          const input_tokens = a.usage?.input_tokens ?? inEst;
          const output_tokens = a.usage?.output_tokens ?? Math.ceil(a.content.length / 2.5) + 50 * a.tool_calls.length;
          const cost_usd = costUsd(model, input_tokens, output_tokens);
          await meter.settle(held, { role, model, input_tokens, output_tokens, cost_usd });
          ctx.log.info(
            { role, model, account_id: body.account_id, attempt, input_tokens, output_tokens, cost_usd, finish: a.finish_reason, metered: a.usage ? 'vultr' : 'estimate', ms: Math.round(performance.now() - started) },
            'model call',
          );
          await audit(body, 'ok', { model, in: input_tokens, out: output_tokens, usd: cost_usd });
          return { model, content: a.content, tool_calls: a.tool_calls, usage: { input_tokens, output_tokens, cost_usd } };
        } catch (e) {
          if (!(e instanceof UpstreamError)) {
            meter.release(held);
            throw e;
          }
          last = e;
          ctx.log.warn({ role, model, attempt, status: e.status, kind: e.kind, ms: Math.round(performance.now() - started) }, 'model call failed');
          if (!e.retry) break;
        }
      }
      meter.release(held);
      await audit(body, 'failed', { reason: last?.kind ?? 'error' });
      if (last?.status === 429) throw new HttpError(429, 'upstream_rate_limited', 'Vultr Inference is rate limiting; try again soon');
      if (last?.kind === 'no_key') throw new HttpError(502, 'no_key', 'the Vultr Inference key is not installed');
      throw new HttpError(502, 'upstream', `Vultr Inference failed (${last?.status ?? 0} ${last?.kind ?? 'error'})`);
    },
    spend: async ({ query }) => meter.spend(query.account_id),
  };
}
