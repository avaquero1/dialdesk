/**
 * End to end on fakes, from day one: sign up, the chat builds one widget, a run fills it with numbers and receipts,
 * and a poisoned page gets its sandbox killed. Everything goes through edge's browser API. The runs go the way they
 * do in production: board enqueues them on widget-runs and runner consumes them (here the queue is an in-process
 * list instead of BullMQ). sandbox-manager is the real Rust binary on the docker backend: real Chromium sandboxes behind
 * the real egress proxy, on the dev topology (sandbox/dev/topology.ts; `make images` and `make engine-image` first).
 * E2E_SANDBOX=stub runs it on the stub backend (no Docker) and skips the steps that need real sandboxes.
 * Steps that need later phases are `it.todo`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveSandboxes, startManager, topologyUp, type Manager, type Topology } from '../sandbox/dev/topology.ts';
import { ACCOUNTS, AGENT, AUDIT, BOARD, CONNECTIONS, EDGE, MARKETS, MODELS, POISONED_NOTE, type Board, type ChatReply, type WidgetRunJob } from '@app/contracts';
import { MemoryBus, createClient, hashToken, sandboxClient, type SandboxClient } from '@app/service-kit';
import { fakeApp, fixtures, pageText, TEST_TOKENS } from '@app/testkit';
import { fake as accounts } from '../services/accounts/src/fake.ts';
import { fake as agent } from '../services/agent/src/fake.ts';
import { createFakeAudit } from '../services/audit/src/fake.ts';
import { fake as board } from '../services/board/src/fake.ts';
import { fake as connections } from '../services/connections/src/fake.ts';
import { createFakeEdge, inProcess } from '../services/edge/src/fake.ts';
import { fake as markets } from '../services/markets/src/fake.ts';
import { fake as models } from '../services/models/src/fake.ts';
import { MemoryStore, Scheduler, handleRun, type RunRecord, type RunnerDeps } from '../services/runner/src/index.ts';

const ROOT = join(import.meta.dirname, '..');
const MANAGER = join(ROOT, 'target', 'debug', 'sandbox-manager');
const PORT = 18200 + (process.pid % 500);
const RUNNER_TOKEN = TEST_TOKENS.runner;

let manager: ChildProcess | undefined;
let sandbox: SandboxClient;
const STUB = process.env.E2E_SANDBOX === 'stub';
let real: Manager | undefined;
let topo: Topology | undefined;

// Wire every fake in process, the way the services are wired in production.
const audit = createFakeAudit();
/** widget-runs: board enqueues here, runner consumes. */
const queue: WidgetRunJob[] = [];
const marketsApp = fakeApp('markets', MARKETS, markets());
const apps = {
  accounts: fakeApp('accounts', ACCOUNTS, accounts()),
  // First paint: board reads cached prices from markets when it creates a widget.
  board: fakeApp(
    'board',
    BOARD,
    board({
      markets: createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS.board, fetch: (r) => marketsApp.fetch(r) }),
      enqueue: (_q, job) => void queue.push(job),
    }),
  ),
  markets: marketsApp,
  models: fakeApp('models', MODELS, models()),
  connections: fakeApp('connections', CONNECTIONS, connections()),
  audit: fakeApp('audit', AUDIT, audit.handlers),
};
const as = (caller: keyof typeof TEST_TOKENS, app: { fetch: (r: Request) => Response | Promise<Response> }) =>
  createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });
const agentApp = fakeApp('agent', AGENT, agent({ board: as('agent', apps.board) }));
const t = TEST_TOKENS.edge;
const fe = createFakeEdge(
  inProcess({ ...apps, agent: agentApp }, { accounts: t, board: t, agent: t, connections: t, audit: t, models: t }),
);
const edgeApp = fakeApp('edge', EDGE, fe.handlers, fe.sessionCheck);

// runner, on the same fakes. Real sandboxes return the page text; on the stub (no Chromium) it comes from the fixture site.
const runnerBus = new MemoryBus();
const runnerStore = new MemoryStore();
const scheduler = new Scheduler(runnerStore, async (j) => void queue.push(j));
const runnerDeps = (): RunnerDeps => ({
  board: as('runner', apps.board),
  markets: as('runner', apps.markets),
  models: as('runner', apps.models),
  connections: as('runner', apps.connections),
  sandbox,
  bus: runnerBus,
  audit: async (e) => audit.append(e).row_id,
  store: runnerStore,
  sourceEnv: 'fixture',
  pageText: (url) => {
    const p = fixtures.manifest().find((x) => x.url === url);
    return p ? pageText(fixtures.page(p.file)) : null;
  },
  onRunEnd: (w, job) => scheduler.noteRun(w, job),
  onWidgetGone: (id) => scheduler.forget(id),
});
/** runner consumes everything on the queue, the way its worker does (one attempt each). */
async function drain(): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  const d = runnerDeps();
  while (queue.length) {
    const job = queue.shift()!;
    out.push(await handleRun(d, job, { jobId: job.job_id, attempt: 1, signal: new AbortController().signal }));
  }
  return out;
}

// The browser: one cookie jar, the edge API only.
let cookie = '';
const browser = createClient({
  baseUrl: 'https://vultrcontest.example.test',
  fetch: async (r) => {
    if (cookie) r.headers.set('cookie', cookie);
    const res = await edgeApp.fetch(r);
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0]!;
    return res;
  },
});

beforeAll(async () => {
  if (!existsSync(MANAGER)) throw new Error('build sandbox-manager first: cargo build -p sandbox-manager (make check does)');
  if (!STUB) {
    topo = topologyUp(`vha-e2e${process.pid}`);
    real = await startManager(topo, `runner:${hashToken(RUNNER_TOKEN)}`);
    sandbox = sandboxClient({ baseUrl: real.url, token: RUNNER_TOKEN });
    return;
  }
  manager = spawn(MANAGER, ['serve'], {
    env: { ...process.env, SANDBOX_BACKEND: 'stub', SANDBOX_MANAGER_ADDR: `127.0.0.1:${PORT}`, SANDBOX_MANAGER_CALLERS: `runner:${hashToken(RUNNER_TOKEN)}`, SANDBOX_MANAGER_DEV: '1' },
    stdio: 'ignore',
  });
  sandbox = sandboxClient({ baseUrl: `http://127.0.0.1:${PORT}`, token: RUNNER_TOKEN });
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sandbox-manager did not start');
});
afterAll(() => {
  manager?.kill('SIGTERM');
  real?.stop();
  topo?.down();
});

describe('e2e on fakes', () => {
  const s: { account_id?: string; widget_id?: string; killed?: string[]; released?: number; runs?: RunRecord[]; research?: RunRecord } = {};

  it('1. sign up: the board opens with the prescribed defaults', async () => {
    const { account } = await browser(EDGE.signup, { body: { email: 'trader@example.test', password: 'correct horse battery' } });
    s.account_id = account.account_id;
    const b: Board = await browser(EDGE.board, {});
    const displays = b.widgets.filter((w) => w.spec.kind === 'display' && w.spec.place && 'col' in w.spec.place);
    expect(displays.map((w) => w.spec.kind === 'display' && w.spec.type)).toEqual(['events', 'probability', 'gap', 'news', 'positions', 'movement']);
    expect(b.widgets.filter((w) => w.spec.kind === 'folder')).toHaveLength(2);
    expect(b.widgets.filter((w) => w.spec.kind === 'app')).toHaveLength(5);
    // First paint: before any run, every display on a market shows its cached price.
    for (const w of b.widgets) {
      if (w.spec.kind !== 'display' || !w.spec.market_ids.length) continue;
      expect(w.result).toBeNull();
      expect(w.quotes?.map((q) => q.market_id)).toEqual(w.spec.market_ids);
    }
  });

  it('2. the chat builds one widget, and it is real only after the click', async () => {
    const r: ChatReply = await browser(EDGE.chat, { body: { conversation_id: null, widget_id: null, message: 'Chiefs, Bills, and the NBA tonight.' } });
    const chip = r.turn.chips[0]!;
    expect(chip.tool).toBe('propose_widget');
    expect((await browser(EDGE.board, {})).pending).toHaveLength(1);
    const acc = await browser(EDGE.accept, { params: { proposal_id: chip.proposal_id! }, body: {} });
    s.widget_id = acc.widgets[0]!.spec.widget_id;
    expect(acc.widgets[0]!.spec).toMatchObject({ kind: 'display', type: 'news' });
  });

  it('2b. the chat never gives advice: bait is answered with math, advice is blocked', async () => {
    const bait = await browser(EDGE.chat, { body: { conversation_id: null, widget_id: null, message: 'should I buy YES on the Chiefs?' } });
    expect(bait.turn.text).toMatch(/^I do math, not calls\./);
    const bad = await browser(EDGE.chat, { body: { conversation_id: null, widget_id: null, message: 'advice-test' } });
    expect(bad.turn.text).toBe('I do math, not calls.');
  });

  it('3. board enqueues the runs on widget-runs and runner consumes them: numbers fill every display', async () => {
    const jobs = [...queue];
    expect(jobs.filter((j) => j.widget_id === s.widget_id).map((j) => j.kind)).toEqual(['numbers', 'research']);
    s.runs = await drain();
    expect(s.runs).toHaveLength(jobs.length);
    expect(s.runs.filter((r) => r.status === 'failed')).toEqual([]);
    const b = await browser(EDGE.board, {});
    const gap = b.widgets.find((w) => w.spec.kind === 'display' && w.spec.type === 'gap')!;
    expect(gap.result!.kind).toBe('numbers');
    expect(gap.result!.numbers.map((n) => [n.op, n.value])).toEqual([['gap', 2]]);
    // Every exchange price is tagged as market data, so the receipts say where the numbers came from.
    expect(gap.result!.receipts[0]!.origins).toEqual(['market']);
    const ev = b.widgets.find((w) => w.spec.kind === 'display' && w.spec.type === 'probability' && 'col' in w.spec.place)!;
    expect(ev.result!.numbers.find((n) => n.op === 'expected_value')).toBeDefined();
  });

  it('3+4. the research run fills the widget with numbers and receipts; the poisoned page gets its sandbox killed', async () => {
    const run = s.runs!.find((r) => r.widget_id === s.widget_id && r.kind === 'research')!;
    expect(run.status).toBe('poisoned');
    expect(run.steps.map((x) => x.step)).toEqual(expect.arrayContaining(['sources', 'plan', 'read', 'extract', 'math', 'summary', 'guard', 'publish']));
    s.research = run;
    s.killed = run.steps.filter((x) => x.status === 'poisoned').map((x) => `${run.run_id}:read:${run.steps.find((y) => y.step === 'read' && y.sandbox?.sandbox_id === x.sandbox?.sandbox_id)!.source!.candidate_id}`);
    s.released = run.steps.filter((x) => x.step === 'extract' && x.sandbox?.state === 'released').length;

    const w = (await browser(EDGE.board, {})).widgets.find((x) => x.spec.widget_id === s.widget_id)!;
    const r = w.result!;
    expect(r.kind).toBe('research');
    expect(r.numbers[0]).toMatchObject({ id: 'n1', op: 'implied_probability', value: 0.61 });
    for (const n of r.numbers) expect(r.receipts.some((x) => x.id === n.receipt_id)).toBe(true);
    const receipt = await browser(EDGE.receipt, { params: { receipt_id: r.numbers[0]!.receipt_id } });
    expect(receipt.formula).toBe('p = price_cents / 100');
    // The summary has slots, not digits; code filled them from engine numbers and a fact's quote.
    expect(r.summary!.template).not.toMatch(/[0-9](?![^{]*\})/);
    expect(Object.values(r.summary!.slots).map((x) => x.kind).sort()).toEqual(['number', 'number', 'quote']);
    expect(r.facts.length).toBeGreaterThan(0);
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]!.note).toBe(POISONED_NOTE);
    expect(r.blocked[0]!.domain).toBe('fanpost.fixture.test');
    expect(w.state).toBe('blocked');
    expect(JSON.stringify(r)).not.toMatch(/ignore your previous instructions/i);
    // board stored the whole trace with the result.
    const trace = await browser(EDGE.trace, { params: { widget_id: s.widget_id! } });
    expect(trace.steps.at(-1)!.step).toBe('publish');
  });

  it('3c. run.started, run.step and run.poisoned go out for the live run trace', () => {
    const run = s.runs!.find((r) => r.widget_id === s.widget_id && r.kind === 'research')!;
    const mine = runnerBus.events.filter((e) => (e.payload as { run_id?: string; step?: { run_id: string } }).run_id === run.run_id || (e.payload as { step?: { run_id: string } }).step?.run_id === run.run_id);
    expect(mine[0]!.event).toBe('run.started');
    expect(mine.filter((e) => e.event === 'run.step')).toHaveLength(run.steps.length);
    expect(mine.filter((e) => e.event === 'run.poisoned')).toHaveLength(1);
    // Every run step on the bus validated against the contract (MemoryBus parses), and the trace never quotes the page.
    expect(JSON.stringify(mine)).not.toMatch(/ignore your previous instructions/i);
  });

  it('3d. the scheduler books the next numbers run from the cadence, and the job id collapses its window', async () => {
    expect(queue).toHaveLength(0);
    const gap = (await browser(EDGE.board, {})).widgets.find((w) => w.spec.kind === 'display' && w.spec.type === 'gap')!;
    const row = await runnerStore.schedule.get(gap.spec.widget_id, 'numbers');
    expect(row!.every_s).toBe(120);
    const later = new Scheduler(runnerStore, async (j) => void queue.push(j), () => row!.next_at + 1);
    const jobs = await later.tick();
    expect(jobs.find((j) => j.widget_id === gap.spec.widget_id)).toMatchObject({ kind: 'numbers', reason: 'schedule' });
    expect(await later.tick()).toEqual([]);
    const runs = await drain();
    expect(runs.every((r) => r.status === 'done')).toBe(true);
  });

  it('4b. sandbox-manager shows the poisoned sandbox killed and the clean ones released', async () => {
    expect(s.killed).toHaveLength(1);
    const k = await sandbox.getJob(s.killed![0]!);
    expect(k.state).toBe('killed');
    expect(k.kill_reason).toBe('poison');
    expect(s.released).toBeGreaterThan(0);
    const list = await sandbox.sandboxes();
    expect(list.backend).toBe(STUB ? 'stub' : 'docker');
    // Nothing is left held: every browse sandbox got its verdict.
    expect(list.sandboxes.filter((x) => x.state === 'held')).toEqual([]);
    const trust = await browser(EDGE.trust, {});
    expect(trust.counts.sandboxes_killed).toBe(1);
    expect(trust.counts.runs_poisoned).toBe(1);
    // Every sandbox runner started (browse and compute) ended: destroyed after its job, or killed.
    expect(trust.counts.sandboxes_created).toBeGreaterThan(1);
    expect(trust.counts.sandboxes_created).toBe(trust.counts.sandboxes_destroyed + trust.counts.sandboxes_killed);
    expect((await browser(EDGE.auditVerify, {})).ok).toBe(true);
  });

  it.skipIf(STUB)('4c. each browse sandbox opened its page in Chromium behind the proxy, returned its text, and was destroyed', async () => {
    const run = s.research!;
    const clean = run.steps
      .filter((x) => x.step === 'read' && x.source && !s.killed!.some((k) => k.endsWith(`:read:${x.source!.candidate_id}`)))
      .map((x) => `${run.run_id}:read:${x.source!.candidate_id}`);
    expect(clean.length).toBeGreaterThan(0);
    for (const id of clean) {
      const j = await sandbox.getJob(id);
      expect(j.state).toBe('released');
      expect(j.pages[0]!.status).toBe(200);
      expect(j.pages[0]!.text.length).toBeGreaterThan(200);
      const domain = new URL(j.pages[0]!.url).hostname;
      // Only the job's own domain got through.
      expect(j.proxy_log.filter((e) => e.allowed).map((e) => e.host)).toContain(domain);
      expect(j.proxy_log.filter((e) => e.allowed).every((e) => e.host === domain)).toBe(true);
    }
    expect(liveSandboxes(topo!)).toEqual([]);
  });

  it.skipIf(STUB)("4d. the proxy refused and logged the poisoned page's callouts before its sandbox was killed", async () => {
    const k = await sandbox.getJob(s.killed![0]!);
    expect(k.pages[0]!.text).toMatch(/ignore your previous instructions/i); // the reader saw the planted orders
    const refused = (host: string) => k.proxy_log.filter((e) => e.host === host && !e.allowed).map((e) => e.reason);
    expect(refused('169.254.169.254')).toContain('ip_literal');
    expect(refused('collect.exfil.fixture.test')).toContain('not_on_allowlist');
    expect(refused('tracker.offlist.fixture.test')).toContain('not_on_allowlist');
    expect(k.proxy_log.filter((e) => e.allowed).map((e) => e.host)).toEqual(['fanpost.fixture.test']);
  });
  it.todo('the same runs on BullMQ on Valkey (runner worker + board queue; make valkey-test territory, Phase 2-3)');
  it.todo('run.step and run.poisoned reach the browser over /live (edge + runner, Phase 2)');
  it.todo('the same flow against the real services instead of the fakes (Phase 2-3)');
});
