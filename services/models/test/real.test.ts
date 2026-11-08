/**
 * The real models against a local mock of Vultr Inference: the contract cases in real mode, caps, the kill switch,
 * the key check and the logs. No network, no real key.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODELS } from '@app/contracts';
import { buildApp, MemoryBus } from '@app/service-kit';
import { runCase, testCallers, TEST_TOKENS, type Case } from '@app/testkit';
import { fingerprint, KeyGuard } from '../src/keyguard.ts';
import { MemoryUsageStore } from '../src/meter.ts';
import { real, type RealDeps } from '../src/real.ts';
import { startMockVultr, type MockVultr } from './mock-vultr.ts';

const KEY = `vtest_${randomBytes(24).toString('base64url')}`;
const OTHER_KEY = `brave_${randomBytes(20).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'models-test-'));
const keyPath = join(dir, 'vultr-inference');
const fpPath = join(dir, 'other.fingerprint.json');
const ACC = 'acc_test0001';
const ACC2 = 'acc_test0002';

let mock: MockVultr;
const logLines: string[] = [];

/**
 * These tests are about the mechanism (fallbacks, caps, logs), so the roles are pinned to fixed lists whose prices the cap
 * cases were written for. The picks themselves are tested against the bake-off in bakeoff.test.ts.
 */
const PINNED_ROLES = {
  ROLE_CHAT: 'glm-5.3,mimo-v2.6-pro',
  ROLE_PLANNER: 'qwen3.8-27b,deepseek-v4.1-flash-1017',
  ROLE_READER: 'qwen3.8-flash-next,mimo-v2.6-flash',
  ROLE_SUMMARIZER: 'qwen3.8-flash-next',
  ROLE_GUARD: 'qwen3.8-flash-next,mimo-v2.6-flash',
};

async function makeApp(cfg: Record<string, string> = {}, deps: RealDeps = {}) {
  const log = pino({ level: 'debug' }, { write: (s: string) => void logLines.push(s) });
  const handlers = await real(
    { VULTR_KEY_FILE: keyPath, VULTR_BASE_URL: mock.url, KEY_FINGERPRINTS: fpPath, TIMEOUT_MS: '5000', ...PINNED_ROLES, ...cfg },
    { store: new MemoryUsageStore(), log, ...deps },
  );
  return buildApp({ service: 'models', mode: 'real', api: MODELS, handlers, callers: testCallers(), log });
}

const ask =
  (role: string, content = 'hello', more: Record<string, unknown> = {}) =>
  () => ({ body: { role, account_id: ACC, messages: [{ role: 'user', content }], ...more } });
const post = (app: Awaited<ReturnType<typeof makeApp>>, body: unknown, caller: 'agent' | 'runner' = 'runner') =>
  app.request('/complete', { method: 'POST', headers: { authorization: `Bearer ${TEST_TOKENS[caller]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const body = (role: string, account_id: string | null = ACC, content = 'hello', more: Record<string, unknown> = {}) => ({
  role,
  account_id,
  messages: [{ role: 'user', content }],
  ...more,
});
const j = (r: Response): Promise<any> => r.json();
const spend = async (app: Awaited<ReturnType<typeof makeApp>>, account_id?: string) =>
  j(await app.request(`/spend${account_id ? `?account_id=${account_id}` : ''}`, { headers: { authorization: `Bearer ${TEST_TOKENS.edge}` } }));

beforeAll(async () => {
  writeFileSync(keyPath, `${KEY}\n`, { mode: 0o600 });
  writeFileSync(fpPath, JSON.stringify(fingerprint('brave', OTHER_KEY)));
  mock = await startMockVultr(KEY);
});
afterAll(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('models real mode: the contract cases against the mock', () => {
  const tool = { name: 'propose_widget', parameters: { type: 'object' } };
  const cases: Case[] = [
    { endpoint: 'complete', caller: 'agent', input: ask('chat'), save: (o, c) => (c.chat = o) },
    { endpoint: 'complete', caller: 'agent', input: ask('chat', 'Chiefs at Bills', { tools: [tool] }), save: (o, c) => (c.tool = o), label: 'tool call' },
    { endpoint: 'complete', caller: 'runner', input: ask('planner', 'plan', { json: true }), save: (o, c) => (c.planner = o), label: 'json, fenced' },
    { endpoint: 'complete', caller: 'runner', input: ask('reader', 'page text') },
    { endpoint: 'complete', caller: 'runner', input: ask('summarizer', 'n1 n2', { max_tokens: 64 }) },
    { endpoint: 'complete', caller: 'runner', input: ask('guard', 'check this') },
    { endpoint: 'complete', caller: 'runner', input: ask('reader', 'x', { tools: [tool] }), expect: 400, label: 'the reader takes no tools' },
    { endpoint: 'complete', caller: 'runner', input: ask('reader', '-----BEGIN PRIVATE KEY----- x'), expect: 400, label: 'a PEM key is refused' },
    { endpoint: 'complete', caller: 'runner', input: ask('reader', `note: ${KEY} end`), expect: 400, label: 'the Vultr key is refused' },
    { endpoint: 'complete', caller: 'runner', input: ask('reader', `frag ${KEY.slice(5, 25)} frag`), expect: 400, label: 'a 20-char slice of the key is refused' },
    { endpoint: 'complete', caller: 'runner', input: ask('reader', `x=${OTHER_KEY.slice(3, 30)}`), expect: 400, label: 'a fingerprinted key is refused' },
    { endpoint: 'spend', caller: 'edge', input: () => ({ query: {} }), save: (o, c) => (c.spend = o) },
    { endpoint: 'spend', caller: 'edge', input: () => ({ query: { account_id: ACC } }), save: (o, c) => (c.accSpend = o) },
  ];
  const ctx: Record<string, any> = {};
  let app: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    app = await makeApp();
  });
  for (const [i, c] of cases.entries())
    it(`${i + 1}. ${c.endpoint}${c.label ? ` (${c.label})` : ''} as ${c.caller}`, async () => {
      const out = await runCase(app, MODELS, c, ctx);
      expect(out.problems).toEqual([]);
    });

  it('answers with the role model, real usage and cost', () => {
    expect(ctx.chat.model).toBe('glm-5.3');
    expect(ctx.chat.usage.input_tokens).toBeGreaterThan(0);
    expect(ctx.chat.usage.cost_usd).toBeCloseTo(ctx.chat.usage.input_tokens * 0.75e-6 + ctx.chat.usage.output_tokens * 3e-6, 12);
    expect(ctx.tool.tool_calls).toEqual([{ name: 'propose_widget', arguments: { widgets: [] } }]);
    expect(ctx.planner.content).toBe('{"ok":true}');
  });

  it('sends the OpenAI shape: tools as functions, json_object, reasoning effort, no tools for the reader', () => {
    const chatReq = mock.requests.find((r) => r.tools);
    expect(chatReq).toMatchObject({ model: 'glm-5.3', tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'propose_widget' } }] });
    expect(mock.requests.find((r) => r.model === 'qwen3.8-27b')).toMatchObject({ response_format: { type: 'json_object' }, reasoning_effort: 'minimal' });
    expect(mock.requests.filter((r) => r.model === 'qwen3.8-flash-next' && r.tools)).toEqual([]);
  });

  it('meters spend per role and per account, and refusals cost nothing', () => {
    expect(mock.requests.length).toBe(6); // the 5 refusals never reached the mock
    expect(ctx.spend.total_usd).toBeGreaterThan(0);
    expect(ctx.spend.by_role.chat).toBeGreaterThan(ctx.spend.by_role.reader);
    expect(ctx.spend.kill_switch).toBe(false);
    expect(ctx.accSpend.total_usd).toBeCloseTo(ctx.spend.total_usd, 8);
    expect(ctx.accSpend.daily_cap_usd).toBe(0.25);
  });
});

describe('models real mode: fallbacks and upstream errors', () => {
  it('a down model falls back to the next one in the role', async () => {
    const app = await makeApp();
    mock.down.add('glm-5.3');
    try {
      const r = await post(app, body('chat'), 'agent');
      expect(r.status).toBe(200);
      expect((await j(r)).model).toBe('mimo-v2.6-pro');
    } finally {
      mock.down.clear();
    }
  });

  it('every model down is a 502, and nothing is billed', async () => {
    const app = await makeApp();
    mock.down.add('qwen3.8-flash-next').add('mimo-v2.6-flash');
    try {
      const r = await post(app, body('reader'));
      expect(r.status).toBe(502);
      expect((await spend(app)).total_usd).toBe(0);
    } finally {
      mock.down.clear();
    }
  });

  it("Vultr's 429 is a 429", async () => {
    const app = await makeApp();
    mock.rateLimited = true;
    try {
      expect((await post(app, body('reader'))).status).toBe(429);
    } finally {
      mock.rateLimited = false;
    }
  });

  it('meters from an estimate when Vultr sends no usage', async () => {
    const app = await makeApp();
    mock.noUsage = true;
    try {
      const r = await j(await post(app, body('reader', ACC, 'some page text')));
      expect(r.usage.input_tokens).toBeGreaterThan(0);
      expect(r.usage.cost_usd).toBeGreaterThan(0);
    } finally {
      mock.noUsage = false;
    }
  });

  it('MODELS_ROLE_<ROLE> overrides the model list; a model with no price refuses to start', async () => {
    const app = await makeApp({ ROLE_READER: 'mimo-v2.6-flash' });
    expect((await j(await post(app, body('reader')))).model).toBe('mimo-v2.6-flash');
    await expect(makeApp({ ROLE_READER: 'no-such-model' })).rejects.toThrow(/no price/);
  });
});

describe('models real mode: the key file', () => {
  it('no key file: 502 no_key; the file appears: calls work without a restart', async () => {
    const later = join(dir, 'later-key');
    const app = await makeApp({ VULTR_KEY_FILE: later });
    const r1 = await post(app, body('reader'));
    expect(r1.status).toBe(502);
    expect((await j(r1)).error).toBe('no_key');
    writeFileSync(later, KEY, { mode: 0o600 });
    expect((await post(app, body('reader'))).status).toBe(200);
    // and the key that appeared is now fingerprinted too
    expect((await post(app, body('reader', ACC, `k ${KEY}`))).status).toBe(400);
  });

  it('a wrong key is a 502 (Vultr 401), not a retry on every model', async () => {
    const bad = join(dir, 'bad-key');
    writeFileSync(bad, 'vtest_wrong_key_0123456789abcdef', { mode: 0o600 });
    const app = await makeApp({ VULTR_KEY_FILE: bad });
    const before = mock.requests.length;
    expect((await post(app, body('chat'), 'agent')).status).toBe(502);
    expect(mock.requests.length - before).toBe(0); // the mock refuses at auth, before it records
  });

  it('never writes the key, or a slice of it, in a log or the audit log', async () => {
    const bus = new MemoryBus();
    const app = await makeApp({}, { bus });
    await post(app, body('reader', ACC, `leak ${KEY}`));
    await post(app, body('chat'), 'agent');
    const all = logLines.join('\n') + JSON.stringify(bus.entries);
    expect(all.length).toBeGreaterThan(100);
    for (let i = 0; i + 12 <= KEY.length; i += 4) expect(all).not.toContain(KEY.slice(i, i + 12));
    expect(all).not.toContain('leak');
    expect(bus.entries.map((e) => [e.action, e.outcome, e.ids.reason ?? e.ids.model])).toEqual([
      ['model.call', 'refused', 'key_in_prompt'],
      ['model.call', 'ok', 'glm-5.3'],
    ]);
  });

  it('logs every call as model.call: ids, a hash of the prompt and sizes, never the prompt or the answer', async () => {
    const bus = new MemoryBus();
    const app = await makeApp({}, { bus });
    const prompt = 'Which NFL teams do you follow? secret-prompt-words-7f3a';
    const r = await post(app, body('chat', ACC, prompt), 'agent');
    expect(r.status).toBe(200);
    const answer: string = (await j(r)).content ?? '';
    expect((await post(app, body('nope', ACC, prompt), 'agent')).status).toBe(400); // a bad body never reaches the log
    expect(bus.entries).toHaveLength(1);
    const e = bus.entries[0]!;
    expect(e).toMatchObject({ service: 'models', action: 'model.call', account_id: ACC, outcome: 'ok', ids: { role: 'chat', model: 'glm-5.3' } });
    expect(Object.keys(e.hashes)).toEqual(['prompt']);
    expect(Object.keys(e.sizes).sort()).toEqual(['cost_microusd', 'input_tokens', 'output_tokens']);
    expect(e.sizes.input_tokens).toBeGreaterThan(0);
    const all = JSON.stringify(bus.entries);
    expect(all).not.toContain('secret-prompt-words');
    expect(all).not.toContain('NFL teams');
    if (answer.length > 8) expect(all).not.toContain(answer);
  });
});

describe('models real mode: caps and the kill switch', () => {
  // every answer bills its full max_tokens, so a cap is reached in a call or two
  beforeAll(() => void (mock.fullOutput = true));
  afterAll(() => void (mock.fullOutput = false));
  it('an account past its daily USD cap gets 402; another account still gets answers', async () => {
    const app = await makeApp({ ACCOUNT_DAILY_USD: '0.004' });
    // a chat call at 1024 output tokens on glm-5.3 costs about $0.0031: one fits, the second can't
    expect((await post(app, body('chat'), 'agent')).status).toBe(200);
    const r = await post(app, body('chat'), 'agent');
    expect(r.status).toBe(402);
    expect((await j(r)).error).toBe('account_usd_cap');
    expect((await post(app, body('chat', ACC2), 'agent')).status).toBe(200);
  });

  it('an account past its daily tokens gets 402', async () => {
    const app = await makeApp({ ACCOUNT_DAILY_TOKENS: '1500' });
    expect((await post(app, body('reader'))).status).toBe(200);
    const r = await post(app, body('reader'));
    expect(r.status).toBe(402);
    expect((await j(r)).error).toBe('account_token_cap');
  });

  it('calls per minute per account: 429 past the limit', async () => {
    const app = await makeApp({ ACCOUNT_RPM: '2' });
    expect((await post(app, body('guard'))).status).toBe(200);
    expect((await post(app, body('guard'))).status).toBe(200);
    expect((await post(app, body('guard'))).status).toBe(429);
    expect((await post(app, body('guard', ACC2))).status).toBe(200);
  });

  it('the global daily cap trips the kill switch: every call is refused, system calls too, until the next UTC day', async () => {
    let t = new Date('2026-11-08T23:59:00Z');
    const app = await makeApp({ DAILY_CAP_USD: '0.004', ACCOUNT_DAILY_USD: '1' }, { clock: () => t });
    expect((await post(app, body('chat'), 'agent')).status).toBe(200);
    // the first call spent ~$0.0031; the next one's worst case doesn't fit under what's left: the switch trips
    const r1 = await post(app, body('chat', ACC2), 'agent');
    expect(r1.status).toBe(402);
    expect((await j(r1)).error).toBe('kill_switch');
    const s = await spend(app);
    expect(s).toMatchObject({ kill_switch: true, daily_cap_usd: 0.004 });
    expect(s.total_usd).toBeLessThanOrEqual(0.004);
    // now even the smallest call, with no account, is refused and never reaches Vultr
    const before = mock.requests.length;
    const r2 = await post(app, body('guard', null, 'x', { max_tokens: 1 }));
    expect(r2.status).toBe(402);
    expect(mock.requests.length).toBe(before);
    t = new Date('2026-11-09T00:00:05Z');
    expect(await spend(app)).toMatchObject({ day: '2026-11-09', total_usd: 0, kill_switch: false });
    expect((await post(app, body('chat'), 'agent')).status).toBe(200);
  });

  it('spend at the cap shows kill_switch true and refuses with kill_switch', async () => {
    const app = await makeApp({ DAILY_CAP_USD: '0' });
    expect((await spend(app)).kill_switch).toBe(true);
    const r = await post(app, body('reader', null));
    expect(r.status).toBe(402);
    expect((await j(r)).error).toBe('kill_switch');
  });

  it('MODELS_KILL=1 refuses every call at once', async () => {
    const app = await makeApp({ KILL: '1' });
    const before = mock.requests.length;
    expect((await post(app, body('chat', null), 'agent')).status).toBe(402);
    expect((await spend(app)).kill_switch).toBe(true);
    expect(mock.requests.length).toBe(before);
  });

  it('calls in flight can never spend past the cap together (reservations)', async () => {
    const app = await makeApp({ DAILY_CAP_USD: '0.01', ACCOUNT_DAILY_USD: '1', ACCOUNT_RPM: '1000' });
    mock.delayMs = 50;
    try {
      const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => post(app, body('chat', `acc_conc${String(i).padStart(4, '0')}`), 'agent')));
      const ok = rs.filter((r) => r.status === 200).length;
      // each chat call's worst case is ~$0.0031, so at most 3 fit under $0.01, in flight or not
      expect(ok).toBeGreaterThan(0);
      expect(ok).toBeLessThanOrEqual(3);
      expect(rs.filter((r) => r.status === 402).length).toBe(12 - ok);
      expect((await spend(app)).total_usd).toBeLessThanOrEqual(0.01);
    } finally {
      mock.delayMs = 0;
    }
  });
});

describe('the key guard', () => {
  const g = new KeyGuard();
  g.addKey('k', KEY);
  it('finds the key whole, as a slice, inside a URL or JSON, and not in ordinary text', () => {
    expect(g.holdsKey(KEY)).toBe(true);
    expect(g.holdsKey(`https://x.test/?token=${KEY.slice(3, 23)}&a=1`)).toBe(true);
    expect(g.holdsKey(JSON.stringify({ api_key: KEY }))).toBe(true);
    expect(g.holdsKey(KEY.slice(0, 15))).toBe(false); // shorter than a window
    for (let i = 0; i + 19 <= KEY.length; i++) expect(g.holdsKey(`x ${KEY.slice(i, i + 19)} y`)).toBe(true); // 19 chars at any offset
    expect(g.holdsKey('KXNFLGAME-26NOV08KCBUF-KC polymarket:nfl-kc-buf-2026-11-08 The Bills are 7-2.')).toBe(false);
  });
  it('a fingerprint file holds no slice of the key', () => {
    const fp = JSON.stringify(fingerprint('k', KEY));
    for (let i = 0; i + 8 <= KEY.length; i++) expect(fp).not.toContain(KEY.slice(i, i + 8));
  });
  it('checks a 200 kB run of key characters fast enough', () => {
    const big = 'a'.repeat(200_000);
    const t = performance.now();
    expect(g.holdsKey(big)).toBe(false);
    expect(performance.now() - t).toBeLessThan(3000);
  });
});
