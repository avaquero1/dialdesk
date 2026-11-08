/**
 * A1.4.3: a board's batch fits what a compute box takes (the engine's MAX_OPS, the manager's request body, the box's
 * output limit), and a receipt id names its data (plan + inputs + op), so a lookup by id finds that game's receipt.
 * The unit tests run the real engine binary; the integration tests run the fakes on the real sandbox-manager (stub
 * backend). Both need target/debug (make check builds it first).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD, EngineResult, MARKETS, MODELS, widgetRunJobId, type EngineInput, type EngineReceipt, type SbxJobStatus, type WidgetRunJob } from '@app/contracts';
import { MemoryBus, RUN_RULES, createClient, hashToken, sandboxClient, type SandboxClient } from '@app/service-kit';
import { fakeApp, TEST_TOKENS } from '@app/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Slots } from '../../agent/src/slots.ts';
import { runTool, type TurnState } from '../../agent/src/tools.ts';
import { createFakeAudit } from '../../audit/src/fake.ts';
import { fake as boardFake } from '../../board/src/fake.ts';
import { fake as marketsFake } from '../../markets/src/fake.ts';
import { fake as modelsFake } from '../../models/src/fake.ts';
import { BOX_LIMITS, ComputeBatch, handleBoardNumbers } from '../src/batch.ts';
import { handleRun, type ComputeRunner, type RunnerDeps } from '../src/run.ts';
import { MemoryStore } from '../src/store.ts';

const ROOT = join(import.meta.dirname, '../../..');
const ENGINE = join(ROOT, 'target/debug/engine');
const MANAGER = join(ROOT, 'target/debug/sandbox-manager');
const PORT = 20000 + (process.pid % 300);
const have = existsSync(ENGINE) && existsSync(MANAGER);

/** A widget's engine input: `ops` numbers off one price, each with the price's source on its receipt. */
function widget(price: number, ops: number, source = 'kalshi:KXNFLGAME-26NOV08CINATL-CIN'): EngineInput {
  return {
    plan: { plan_version: 1, ops: Array.from({ length: ops }, (_, i) => ({ id: `n${i + 1}`, op: 'implied_probability' as const, args: { price_cents: 'price' } })) },
    numbers: { price },
    origins: { price: 'market' },
    provenance: { price: { source, as_of: '2026-11-08T12:00:00Z' } },
  };
}

/** Computes on the real engine binary and keeps each box's input and output size. */
function engineRunner() {
  const inputs: EngineInput[] = [];
  const outputs: number[] = [];
  const runner: ComputeRunner = {
    computeOne: async (_s, input) => {
      inputs.push(input);
      const out = execFileSync(ENGINE, { input: JSON.stringify(input), maxBuffer: 1 << 26 });
      outputs.push(out.length);
      return { job_id: `job${inputs.length}`, sandbox_id: `sbx${inputs.length}`, state: 'done', compute_result: JSON.parse(String(out)), trust_log: [{ box: inputs.length }] } as unknown as SbxJobStatus;
    },
  };
  return { runner, inputs, outputs };
}

/** Every widget hands its input to one batch; each gets back its own status. */
async function batch(inputs: EngineInput[], runner: ComputeRunner) {
  const b = new ComputeBatch(inputs.length, 60_000);
  const settled = await Promise.allSettled(inputs.map((input, i) => b.slot(i).compute(runner, {} as never, input)));
  return { b, settled };
}
const result = (s: PromiseSettledResult<SbxJobStatus | null>) => EngineResult.parse((s as PromiseFulfilledResult<SbxJobStatus>).value.compute_result);
const widgetsOf = (i: EngineInput) => [...new Set(i.plan.ops.map((o) => o.id.split('_')[0]!))];

describe.skipIf(!have)('a batch fits its compute box (A1.4.3)', () => {
  it('over the engine cap: as few boxes as fit, widgets in order, every widget gets its own numbers', async () => {
    const inputs = Array.from({ length: 20 }, (_, i) => widget(i + 10, 20));
    const { runner, inputs: boxes } = engineRunner();
    const { b, settled } = await batch(inputs, runner);
    expect(b.boxes).toBe(2); // 400 ops: 12 widgets (240) fit under 256, the other 8 go in the second box
    expect(boxes.map((x) => x.plan.ops.length)).toEqual([240, 160]);
    expect(boxes.flatMap(widgetsOf)).toEqual(inputs.map((_, i) => `b${i}`));
    settled.forEach((s, i) => {
      const er = result(s);
      expect(er.ok, `widget ${i}`).toBe(true);
      expect(er.errors).toEqual([]);
      expect(er.numbers.map((n) => n.id)).toEqual(inputs[i]!.plan.ops.map((o) => o.id));
      expect(er.numbers[0]!.value).toBeCloseTo((i + 10) / 100, 9);
      expect(er.receipts).toHaveLength(20);
      expect(er.receipts.every((r) => r.op_id.startsWith(`b${i}_`))).toBe(true);
    });
  });

  it('the normal case stays one box', async () => {
    const { runner } = engineRunner();
    const { b, settled } = await batch(Array.from({ length: 12 }, (_, i) => widget(i + 10, 21)), runner);
    expect(b.boxes).toBe(1); // 252 ops
    expect(settled.every((s) => result(s).ok)).toBe(true);
  });

  it('each box’s trust rows go only to the widget whose run opened it', async () => {
    const inputs = Array.from({ length: 20 }, (_, i) => widget(i + 10, 20));
    const { runner } = engineRunner();
    const { settled } = await batch(inputs, runner);
    const rows = settled.map((s) => (s as PromiseFulfilledResult<SbxJobStatus>).value.trust_log?.length ?? 0);
    expect(rows.map((n, i) => (n ? i : -1)).filter((i) => i >= 0)).toEqual([0, 12]);
  });

  it('a widget too big for a box on its own fails alone; the others get their numbers', async () => {
    const inputs = [widget(40, 20), widget(50, BOX_LIMITS.ops + 1), widget(60, 20)];
    const { runner } = engineRunner();
    const { settled } = await batch(inputs, runner);
    expect(result(settled[0]!).ok).toBe(true);
    expect(result(settled[2]!).ok).toBe(true);
    expect(result(settled[1]!).errors.map((e) => [e.op_id, e.code])).toEqual([['plan', 'bad_plan']]);
    expect(result(settled[2]!).numbers[0]!.value).toBeCloseTo(0.6, 9);
  });

  it('a widget the engine would refuse fails alone: its plan error does not reach the others', async () => {
    const dup = widget(50, 2);
    dup.plan.ops[1]!.id = 'n1';
    const orphan = widget(55, 2);
    orphan.origins = { nowhere: 'market' };
    const inputs = [widget(40, 3), dup, orphan, widget(60, 3)];
    const { runner } = engineRunner();
    const { settled } = await batch(inputs, runner);
    expect(result(settled[0]!).ok).toBe(true);
    expect(result(settled[3]!).ok).toBe(true);
    expect(result(settled[1]!).errors[0]).toMatchObject({ code: 'bad_plan' });
    expect(result(settled[2]!).errors[0]).toMatchObject({ code: 'bad_plan' });
  });

  it('one widget’s op error stays its own', async () => {
    const bad = widget(40, 3);
    bad.plan.ops[1]!.args = { price_cents: 'not_there' };
    const inputs = [widget(30, 3), bad, widget(50, 3)];
    const { runner } = engineRunner();
    const { settled } = await batch(inputs, runner);
    expect(result(settled[0]!).ok).toBe(true);
    expect(result(settled[2]!).ok).toBe(true);
    const er = result(settled[1]!);
    expect(er.errors.map((e) => [e.op_id, e.code])).toEqual([['n2', 'missing_input']]);
    expect(er.numbers.map((n) => n.id)).toEqual(['n1', 'n3']);
  });

  it('a box that fails fails only its own widgets', async () => {
    const inputs = Array.from({ length: 20 }, (_, i) => widget(i + 10, 20));
    const real = engineRunner();
    const runner: ComputeRunner = {
      computeOne: (s, i) => (i.plan.ops[0]!.id.startsWith('b12_') ? Promise.reject(new Error('box down')) : real.runner.computeOne(s, i)),
    };
    const { settled } = await batch(inputs, runner);
    expect(settled.map((s) => s.status)).toEqual([...Array(12).fill('fulfilled'), ...Array(8).fill('rejected')]);
  });

  it('inputs and outputs stay under the box’s byte limits: long sources split sooner than the op cap', async () => {
    const source = `kalshi:${'X'.repeat(190)}`;
    const inputs = Array.from({ length: 12 }, (_, i) => widget(i + 10, 21, source));
    const { runner, inputs: boxes, outputs } = engineRunner();
    const { settled } = await batch(inputs, runner);
    expect(boxes.length).toBeGreaterThan(1);
    expect(Math.max(...outputs)).toBeLessThanOrEqual(BOX_LIMITS.outputBytes);
    expect(settled.every((s) => result(s).ok)).toBe(true);
  });

  it('a big input splits under the request limit', async () => {
    const big = (price: number): EngineInput => {
      const w = widget(price, 2);
      return { ...w, numbers: { ...w.numbers, line: Array.from({ length: 24_000 }, (_, t) => ({ t: 1_700_000_000 + t * 60, v: 50.123 })) } };
    };
    const { runner, inputs: boxes } = engineRunner();
    const { settled } = await batch([big(40), big(50), big(60), big(70)], runner);
    expect(boxes.length).toBeGreaterThan(1);
    for (const x of boxes) expect(Buffer.byteLength(JSON.stringify(x))).toBeLessThanOrEqual(BOX_LIMITS.inputBytes);
    expect(settled.every((s) => result(s).ok)).toBe(true);
  });

  it('the cap is the engine’s', () => {
    expect(readFileSync(join(ROOT, 'engine/src/lib.rs'), 'utf8')).toContain(`pub const MAX_OPS: usize = ${BOX_LIMITS.ops};`);
    expect(readFileSync(join(ROOT, 'sandbox/manager/src/types.rs'), 'utf8')).toMatch(new RegExp(`COMPUTE: Limits = Limits \\{[^}]*output_kb: ${BOX_LIMITS.outputBytes / 1024},`));
  });

  it('runner waits longer than a compute box can live', () => {
    const wall = readFileSync(join(ROOT, 'sandbox/manager/src/types.rs'), 'utf8').match(/COMPUTE: Limits = Limits \{[^}]*wall_s: (\d+),/)?.[1];
    expect(wall).toBe('15');
    expect(RUN_RULES.timeoutsMs.compute).toBeGreaterThan(Number(wall) * 1000);
  });
});

// ---------- the whole path, on the fakes and the real sandbox-manager (stub backend) ----------

const marketsApp = fakeApp('markets', MARKETS, marketsFake());
const via = (caller: keyof typeof TEST_TOKENS, app: { fetch: (r: Request) => Response | Promise<Response> }) =>
  createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });
const boardApp = fakeApp('board', BOARD, boardFake({ markets: via('board', marketsApp), enqueue: () => undefined }));
const edge = via('edge', boardApp);
const agent = via('agent', boardApp);
const runnerMarkets = via('runner', marketsApp);
const audit = createFakeAudit();
const ctx = () => ({ jobId: 'j', attempt: 1, signal: new AbortController().signal });

let manager: ChildProcess | undefined;
let sandbox: SandboxClient;

beforeAll(async () => {
  if (!have) return;
  manager = spawn(MANAGER, ['serve'], {
    env: { ...process.env, SANDBOX_MANAGER_ADDR: `127.0.0.1:${PORT}`, SANDBOX_MANAGER_CALLERS: `runner:${hashToken(TEST_TOKENS.runner)}`, SANDBOX_MANAGER_DEV: '1' },
    stdio: 'ignore',
  });
  sandbox = sandboxClient({ baseUrl: `http://127.0.0.1:${PORT}`, token: TEST_TOKENS.runner });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sandbox-manager did not start');
}, 30_000);
afterAll(() => {
  manager?.kill('SIGTERM');
});

function deps() {
  const boxes: EngineInput[] = [];
  const counted: SandboxClient = {
    ...sandbox,
    createJob: (req) => {
      if (req.kind === 'compute') boxes.push(req.compute!.engine_input as EngineInput);
      return sandbox.createJob(req);
    },
  };
  const d = {
    board: via('runner', boardApp),
    markets: runnerMarkets,
    models: via('runner', fakeApp('models', MODELS, modelsFake())),
    sandbox: counted,
    bus: new MemoryBus(),
    audit: async (e: never) => audit.append(e).row_id,
    store: new MemoryStore(),
    sourceEnv: 'fixture',
    pollMs: 10,
  } as unknown as RunnerDeps;
  return { d, boxes };
}

let seq = 0;
async function board() {
  const account_id = `acc_batchcap${String(++seq).padStart(4, '0')}${Math.floor(Math.random() * 1e6)}`;
  await edge(BOARD.createDefaults, { params: { account_id }, body: { category: 'sports' } });
  return account_id;
}
async function marketCard(account_id: string, market_id: string, title: string) {
  const widget = { kind: 'display' as const, type: 'probability' as const, title, market_ids: [market_id], params: {} };
  const p = await agent(BOARD.propose, { params: { account_id }, body: { changes: [{ op: 'add', widget }] } });
  return (await edge(BOARD.accept, { params: { proposal_id: p.proposal_id }, body: { account_id } })).widgets[0]!.spec.widget_id;
}
const numbersJob = (widget_id: string, account_id: string, window_start: number): WidgetRunJob =>
  ({ job_id: widgetRunJobId(widget_id, 'numbers', window_start), widget_id, account_id, kind: 'numbers', window_start, reason: 'accept' });

describe.skipIf(!have)('the whole path (A1.4.3)', () => {
  it('the manager refuses a request over its body limit, and a full box stays under it', async () => {
    const post = (size: number) =>
      fetch(`http://127.0.0.1:${PORT}/jobs`, { method: 'POST', headers: { authorization: `Bearer ${TEST_TOKENS.runner}`, 'content-type': 'application/json' }, body: 'x'.repeat(size) }).then((r) => r.status);
    expect(await post(2 * 1024 * 1024 + 1)).toBe(413);
    expect(await post(BOX_LIMITS.inputBytes)).toBe(400); // read, then refused as not a job
  });

  it('a board over the cap computes in more than one box and every widget gets its numbers', async () => {
    const account_id = await board();
    const list = await runnerMarkets(MARKETS.list, { query: { category: 'sports' } });
    const market = list.markets[0]!.market_id;
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await marketCard(account_id, market, `Card ${i}`));
    const { d, boxes } = deps();
    const window_start = Math.floor(Date.now() / 1000);
    const recs = await handleBoardNumbers(d, numbersJob(ids[0]!, account_id, window_start), ctx(), ids);
    const total = boxes.reduce((n, b) => n + b.plan.ops.length, 0);
    expect(total, 'the board has more ops than one box takes').toBeGreaterThan(BOX_LIMITS.ops);
    expect(boxes.length).toBeGreaterThan(1);
    for (const b of boxes) expect(b.plan.ops.length).toBeLessThanOrEqual(BOX_LIMITS.ops);
    expect(recs.map((r) => r.status)).toEqual(ids.map(() => 'done'));
    for (const widget_id of ids) {
      const w = await edge(BOARD.getWidget, { params: { widget_id }, query: { account_id } });
      expect(w.result?.numbers.length, widget_id).toBeGreaterThan(0);
      expect(w.result!.receipts.length).toBe(w.result!.numbers.length);
    }
  }, 60_000);

  it('two market cards on different games, run solo: the agent’s lookup for card B’s number gives card B’s receipt', async () => {
    const account_id = await board();
    const list = await runnerMarkets(MARKETS.list, { query: { category: 'sports' } });
    const [a, b] = pickTwo(list.markets);
    const cardA = await marketCard(account_id, a.market_id, 'Card A');
    const cardB = await marketCard(account_id, b.market_id, 'Card B');
    const { d } = deps();
    const window_start = Math.floor(Date.now() / 1000);
    for (const id of [cardA, cardB]) expect((await handleRun(d, numbersJob(id, account_id, window_start), ctx())).status).toBe('done');
    const get = async (widget_id: string) => (await edge(BOARD.getWidget, { params: { widget_id }, query: { account_id } })).result!;
    const [ra, rb] = [await get(cardA), await get(cardB)];
    const first = (r: typeof ra): EngineReceipt => r.receipts.find((x) => x.op === 'implied_probability')!;
    const [fa, fb] = [first(ra), first(rb)];
    expect(fb.plan_hash, 'same plan').toBe(fa.plan_hash);
    expect(fb.value, 'different games').not.toBe(fa.value);
    expect(fb.provenance?.price_cents?.source).toBe(b.market_id);

    const opened = await edge(BOARD.getReceipt, { params: { receipt_id: fb.id }, query: { account_id } });
    expect(opened.provenance?.price_cents?.source).toBe(b.market_id);

    const st = { account_id, widget_id: null, board: [], userTexts: [], slots: new Slots(), chips: [], pending: new Map(), shown: [], settingDigits: new Set(), seen: new Set(), calls: 0, refused: 0 } as unknown as TurnState;
    const out = await runTool('read_receipt', { receipt_id: fb.id }, st, { board: agent } as never);
    expect(out).toMatchObject({ ok: true, receipt_id: fb.id, op: 'implied_probability' });
    const own = new Slots();
    own.receipt(fb);
    expect(st.slots.fill('{n1}').text).toBe(own.fill('{n1}').text);
  });
});

/** Two markets of one league at different prices: their cards get the same plan. */
function pickTwo<M extends { market_id: string; league?: string | null; event_key?: string | null; yes_price_cents?: number | null }>(list: M[]): [M, M] {
  for (const a of list) {
    const b = list.find((x) => x.league === a.league && x.event_key !== a.event_key && x.market_id.split(':')[0] === a.market_id.split(':')[0] && x.yes_price_cents !== a.yes_price_cents);
    if (b) return [a, b];
  }
  throw new Error('no two markets of a league at different prices');
}
