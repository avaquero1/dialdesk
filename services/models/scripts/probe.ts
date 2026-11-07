/**
 * One cheap real call per role and candidate model (a few tokens each), through the real handlers: key check,
 * caps and metering included. Prints one JSON line per call: role, model, status, latency, tokens, cost.
 * Never prints the key or a prompt. Spends well under a cent; the run is capped at $0.02.
 *
 *   MODELS_VULTR_KEY_FILE=<path> npm run probe -w services/models
 */
import { MODELS, type ModelRole } from '@app/contracts';
import { createLogger, HttpError } from '@app/service-kit';
import { MemoryUsageStore } from '../src/meter.ts';
import { real } from '../src/real.ts';
import { ROLES } from '../src/roles.ts';

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('MODELS_')).map(([k, v]) => [k.slice(7), v ?? '']));
const log = createLogger('models', 'warn');
const extra = (process.argv[2] ?? '').split(',').filter(Boolean); // more models to try, e.g. glm-5.3-flash
const tool = { name: 'quote_market', parameters: { type: 'object', properties: { market_id: { type: 'string' } }, required: ['market_id'] } };
const asks: Record<ModelRole, { content: string; tools?: (typeof tool)[]; json?: boolean }> = {
  chat: { content: 'Call quote_market for market kalshi:TEST.', tools: [tool] },
  planner: { content: 'Answer with the JSON object {"ok":true} and nothing else.', json: true },
  reader: { content: 'Page: "The game starts at 8 PM." Answer with one short sentence: when does it start?' },
  summarizer: { content: 'Answer with the JSON object {"template":"{n1}"} and nothing else.', json: true },
  guard: { content: 'User: what time is the game? Agent: It starts at 8 PM.' },
};
const ctx = { caller: 'runner' as const, accountId: null, sessionId: null, log, setHeader: () => {} };
for (const [role, spec] of Object.entries(ROLES) as [ModelRole, (typeof ROLES)[ModelRole]][]) {
  for (const model of [...spec.models, ...(role === 'reader' ? extra : [])]) {
    const h = await real({ ...env, [`ROLE_${role.toUpperCase()}`]: model, DAILY_CAP_USD: '0.02', DATABASE_URL: '' }, { store: new MemoryUsageStore(), log });
    const a = asks[role];
    const started = performance.now();
    try {
      const out = await h.complete({ params: {}, query: {}, body: MODELS.complete.body!.parse({ role, account_id: null, max_tokens: 64, messages: [{ role: 'user', content: a.content }], ...(a.tools && { tools: a.tools }), ...(a.json && { json: true }) }) }, ctx);
      const o = MODELS.complete.response.parse(out);
      process.stdout.write(JSON.stringify({ role, model, status: 200, answered_by: o.model, ms: Math.round(performance.now() - started), usage: o.usage, chars: o.content.length, tool_calls: o.tool_calls.map((t) => t.name), json_ok: a.json ? isJson(o.content) : undefined }) + '\n');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      process.stdout.write(JSON.stringify({ role, model, status, ms: Math.round(performance.now() - started), error: e instanceof HttpError ? `${e.code}: ${e.message}` : (e as Error).message }) + '\n');
    }
  }
}
function isJson(s: string) {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
