/**
 * End to end on fakes, from day one: sign up, the chat builds one widget, a run fills it with numbers and receipts,
 * and a poisoned page gets its sandbox killed. Everything goes through edge's browser API except the run, which
 * e2e/run-on-fakes.ts plays until runner exists. sandbox-manager is the real Rust binary (docker backend stub).
 * Steps that need Phase 1+ are `it.todo`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, AGENT, AUDIT, BOARD, CONNECTIONS, EDGE, MARKETS, MODELS, POISONED_NOTE, type Board, type ChatReply } from '@app/contracts';
import { createClient, hashToken, sandboxClient, type SandboxClient } from '@app/service-kit';
import { fakeApp, TEST_TOKENS } from '@app/testkit';
import { fake as accounts } from '../services/accounts/src/fake.ts';
import { fake as agent } from '../services/agent/src/fake.ts';
import { createFakeAudit } from '../services/audit/src/fake.ts';
import { fake as board } from '../services/board/src/fake.ts';
import { fake as connections } from '../services/connections/src/fake.ts';
import { createFakeEdge, inProcess } from '../services/edge/src/fake.ts';
import { fake as markets } from '../services/markets/src/fake.ts';
import { fake as models } from '../services/models/src/fake.ts';
import { researchRun } from './run-on-fakes.ts';

const ROOT = join(import.meta.dirname, '..');
const MANAGER = join(ROOT, 'target', 'debug', 'sandbox-manager');
const PORT = 18200 + (process.pid % 500);
const RUNNER_TOKEN = TEST_TOKENS.runner;

let manager: ChildProcess;
let sandbox: SandboxClient;

// Wire every fake in process, the way the services are wired in production.
const audit = createFakeAudit();
const marketsApp = fakeApp('markets', MARKETS, markets());
const apps = {
  accounts: fakeApp('accounts', ACCOUNTS, accounts()),
  // First paint: board reads cached prices from markets when it creates a widget.
  board: fakeApp('board', BOARD, board({ markets: createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS.board, fetch: (r) => marketsApp.fetch(r) }) })),
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
  manager = spawn(MANAGER, ['serve'], {
    env: { ...process.env, SANDBOX_MANAGER_ADDR: `127.0.0.1:${PORT}`, SANDBOX_MANAGER_CALLERS: `runner:${hashToken(RUNNER_TOKEN)}`, SANDBOX_MANAGER_DEV: '1' },
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
});

describe('e2e on fakes', () => {
  const s: { account_id?: string; widget_id?: string; killed?: string[] } = {};

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

  it('3+4. a research run fills the widget with numbers and receipts; the poisoned page gets its sandbox killed', async () => {
    const out = await researchRun(
      { board: as('runner', apps.board), markets: as('runner', apps.markets), models: as('runner', apps.models), sandbox, audit: audit.append },
      s.account_id!,
      s.widget_id!,
    );
    expect(out.verdict.outcome).toBe('pass');
    s.killed = out.killed;

    const w = (await browser(EDGE.board, {})).widgets.find((x) => x.spec.widget_id === s.widget_id)!;
    const r = w.result!;
    expect(r.numbers.map((n) => [n.id, n.value])).toEqual([
      ['n1', 0.61],
      ['n2', 2],
    ]);
    for (const n of r.numbers) expect(r.receipts.some((x) => x.id === n.receipt_id)).toBe(true);
    const receipt = await browser(EDGE.receipt, { params: { receipt_id: r.numbers[0]!.receipt_id } });
    expect(receipt.formula).toBe('p = price_cents / 100');
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]!.note).toBe(POISONED_NOTE);
    expect(r.blocked[0]!.domain).toBe('fanpost.fixture.test');
    expect(w.state).toBe('blocked');
    expect(JSON.stringify(r)).not.toMatch(/ignore your previous instructions/i);
  });

  it('4b. sandbox-manager shows the poisoned sandbox killed and the clean ones released', async () => {
    expect(s.killed).toHaveLength(1);
    const k = await sandbox.getJob(s.killed![0]!);
    expect(k.state).toBe('killed');
    expect(k.kill_reason).toBe('poison');
    const list = await sandbox.sandboxes();
    expect(list.backend).toBe('docker');
    const trust = await browser(EDGE.trust, {});
    expect(trust.counts.sandboxes_killed).toBe(1);
    expect(trust.counts.runs_poisoned).toBe(1);
    expect((await browser(EDGE.auditVerify, {})).ok).toBe(true);
  });

  it.todo('the browse sandbox opens the page in Chromium behind the proxy and returns its text (sandbox-manager, Phase 1)');
  it.todo("the proxy refuses the poisoned page's callouts: 169.254.169.254, collect.exfil.fixture.test, tracker.offlist.fixture.test (Phase 1)");
  it.todo('board enqueues the run on widget-runs and runner consumes it (BullMQ on Valkey, Phase 1-2)');
  it.todo('run.step and run.poisoned reach the browser over /live (edge + runner, Phase 2)');
  it.todo('the same flow against the real services instead of the fakes (Phase 2-3)');
});
