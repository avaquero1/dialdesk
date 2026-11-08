/**
 * Milestone D1.3 (roadmap, Track 4 "Your data"): "Your account" shows the balance and positions, read only, and a key
 * that can trade is refused with a plain reason.
 *
 * Everything goes through edge's browser API on the fakes, the way the web app calls it: connect (connections' fake
 * opens no sealed key and calls no exchange; a Kalshi key id containing "write" is a key that can trade), consent,
 * link the account to the display (edge -> board, which checks both are this account's), then the run board asks for
 * goes through runner's positionNumbers and the real engine in a compute sandbox (sandbox-manager on its dev
 * backend). The display is rendered with the web app's own widgets.ts. No real key and no real exchange: the key id is
 * made up and the sealed key is not a key.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, AUDIT, BOARD, CONNECTIONS, EDGE, MARKETS, MODELS, type Board, type Connection, type Widget, type WidgetRunJob } from '@app/contracts';
import { CallError, MemoryBus, createClient, hashToken, sandboxClient, type SandboxClient } from '@app/service-kit';
import { fakeApp, TEST_TOKENS } from '@app/testkit';
import { fake as accounts } from '../services/accounts/src/fake.ts';
import { createFakeAudit } from '../services/audit/src/fake.ts';
import { fake as board } from '../services/board/src/fake.ts';
import { fake as connections } from '../services/connections/src/fake.ts';
import { createFakeEdge, inProcess } from '../services/edge/src/fake.ts';
import { fake as markets } from '../services/markets/src/fake.ts';
import { fake as models } from '../services/models/src/fake.ts';
import { runJob, type DisplaySpec } from '../services/board/src/logic.ts';
import { handleRun } from '../services/runner/src/run.ts';
import { MemoryStore } from '../services/runner/src/store.ts';

const MANAGER = join(import.meta.dirname, '..', 'target', 'debug', 'sandbox-manager');
const PORT = 18900 + (process.pid % 90);
const SEALED = 'bm90LWEta2V5LWp1c3QtYnl0ZXMtZm9yLXRoZS1mYWtl';

const as = (caller: keyof typeof TEST_TOKENS, app: { fetch: (r: Request) => Response | Promise<Response> }) =>
  createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });
const queue: WidgetRunJob[] = [];
const marketsApp = fakeApp('markets', MARKETS, markets());
const connectionsApp = fakeApp('connections', CONNECTIONS, connections());
const audit = createFakeAudit();
const boardApp = fakeApp('board', BOARD, board({ markets: as('board', marketsApp), connections: as('board', connectionsApp), enqueue: (_q, j) => void queue.push(j) }));
const apps = {
  accounts: fakeApp('accounts', ACCOUNTS, accounts()),
  board: boardApp,
  connections: connectionsApp,
  models: fakeApp('models', MODELS, models()),
  audit: fakeApp('audit', AUDIT, audit.handlers),
};
const t = TEST_TOKENS.edge;
const fe = createFakeEdge(inProcess(apps, { accounts: t, board: t, connections: t, models: t, audit: t }));
const edgeApp = fakeApp('edge', EDGE, fe.handlers, fe.sessionCheck);

/** A browser: its own cookie jar, edge's API only. */
function browser() {
  let cookie = '';
  return createClient({
    baseUrl: 'https://vultrcontest.example.test',
    fetch: async (r) => {
      if (cookie) r.headers.set('cookie', cookie);
      const res = await edgeApp.fetch(r);
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0]!;
      return res;
    },
  });
}

let manager: ChildProcess | undefined;
let sandbox: SandboxClient;
/** runner takes the runs board asked for this widget, one attempt each, as its worker does (the board's others are dropped). */
async function drain(widget_id: string) {
  const out = [];
  for (const job of queue.splice(0).filter((j) => j.widget_id === widget_id)) {
    out.push(
      await handleRun(
        {
          board: as('runner', boardApp),
          markets: as('runner', marketsApp),
          models: as('runner', apps.models),
          connections: as('runner', connectionsApp),
          sandbox,
          bus: new MemoryBus(),
          audit: async (e) => audit.append(e).row_id,
          store: new MemoryStore(),
          sourceEnv: 'fixture',
          pageText: () => null,
          pollMs: 10,
        },
        job,
        { jobId: job.job_id, attempt: 1, signal: new AbortController().signal },
      ),
    );
  }
  return out;
}

/** widgets.ts as the page runs it (dom.ts reads document at import; nothing else here needs one). */
async function web() {
  (globalThis as { document?: unknown }).document ??= { documentElement: {} };
  // By a path in a variable: the root typecheck has no DOM types; web/tsconfig.json checks these files.
  const at = (f: string) => import(/* @vite-ignore */ join(import.meta.dirname, '..', 'web', 'src', f));
  const [w, c] = await Promise.all([at('widgets.ts'), at('conns.ts')]);
  return {
    displayHtml: w.displayHtml as (w: Widget, c: { titles: Map<string, string> }) => string,
    setConnections: c.setConnections as (l: Connection[]) => void,
  };
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

beforeAll(async () => {
  if (!existsSync(MANAGER)) throw new Error('build sandbox-manager first: cargo build -p sandbox-manager (make check does)');
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
});
afterAll(() => void manager?.kill());

describe('Milestone D1.3: "Your account" shows the balance and positions, read only', () => {
  const me = browser();
  let display: Widget;
  let con: Connection;

  it('a key that can trade is refused with a plain reason, and nothing is stored', async () => {
    await me(EDGE.guest, { body: {} });
    const b: Board = await me(EDGE.board, {});
    display = b.widgets.find((w) => w.spec.kind === 'display' && w.spec.type === 'positions')!;
    expect(display, 'the first board has a Your account display').toBeTruthy();
    const err = await me(EDGE.connect, {
      body: { exchange: 'kalshi', key_id: 'kalshi-write-key-0001', key_type: 'ed25519', sealed_key: SEALED, env: 'demo' },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallError);
    expect((err as CallError).status).toBe(403);
    expect((err as CallError).body).toMatchObject({ error: 'write_scope', message: 'This key can trade. Make a read-only key and paste that one.' });
    expect((await me(EDGE.connections, {})).connections).toEqual([]);
  });

  it('a read-only key connects; linked before consent, the display reads nothing', async () => {
    con = await me(EDGE.connect, { body: { exchange: 'kalshi', key_id: 'kalshi-read-key-0001', key_type: 'ed25519', sealed_key: SEALED, env: 'demo' } });
    expect(con).toMatchObject({ scope: 'read', scope_verified: true, share_numbers: false });
    const w = await me(EDGE.linkConnection, { params: { widget_id: display.spec.widget_id }, body: { connection_id: con.connection_id } });
    expect(w.spec.kind === 'display' && w.spec.params.connection_id).toBe(con.connection_id);
    const [run] = await drain(display.spec.widget_id);
    expect(run!.steps.map((s) => [s.step, s.status, s.note])).toEqual([['math', 'skipped', 'not connected (numbers not shared)']]);
    expect((await me(EDGE.board, {})).widgets.find((x) => x.spec.widget_id === display.spec.widget_id)!.result).toBeNull();
  });

  it("another account can't put my connection on its display, or link to my display", async () => {
    const other = browser();
    await other(EDGE.guest, { body: {} });
    const theirs = (await other(EDGE.board, {})).widgets.find((w) => w.spec.kind === 'display' && w.spec.type === 'positions')!;
    const a = await other(EDGE.linkConnection, { params: { widget_id: theirs.spec.widget_id }, body: { connection_id: con.connection_id } }).catch((e: CallError) => e.status);
    const b = await other(EDGE.linkConnection, { params: { widget_id: display.spec.widget_id }, body: { connection_id: con.connection_id } }).catch((e: CallError) => e.status);
    expect([a, b]).toEqual([404, 404]);
  });

  it('with consent: balance, positions and today\'s change, each from the engine with a receipt from the read-only account', async () => {
    con = await me(EDGE.consent, { params: { connection_id: con.connection_id }, body: { share_numbers: true } });
    // The link's run of this minute already ran (above); runner reads again on the display's next run.
    const linked = (await me(EDGE.board, {})).widgets.find((x) => x.spec.widget_id === display.spec.widget_id)!;
    queue.push(runJob(linked.spec as DisplaySpec, 'numbers', 'schedule', Date.now() + 60_000));
    const [run] = await drain(display.spec.widget_id);
    expect(run!.status).toBe('done');
    const w = (await me(EDGE.board, {})).widgets.find((x) => x.spec.widget_id === display.spec.widget_id)!;
    display = w;
    const r = w.result!;
    const ids = r.numbers.map((n) => n.id);
    expect(ids[0]).toBe('balance');
    expect(ids).toContain('value_1');
    expect(ids).toContain('pnl_1');
    expect(ids).toContain('today_1');
    expect(r.numbers.every((n) => n.unit === 'dollars')).toBe(true);
    for (const n of r.numbers) {
      const rc = await me(EDGE.receipt, { params: { receipt_id: n.receipt_id } });
      expect(rc.op_id).toBe(n.id);
      expect(rc.value).toBe(n.value);
      expect(rc.origins).toContain('connection');
      // Provenance: the exchange, read only, and the time connections read it.
      const acct = Object.values(rc.provenance ?? {}).find((p) => p.source === 'Kalshi account, read only');
      expect(acct, `${n.id}: the account's provenance`).toBeTruthy();
      expect(Number.isNaN(Date.parse(acct!.as_of))).toBe(false);
    }
    // Nothing but numbers left connections: no key, key id or sealed box in the result.
    const json = JSON.stringify(r);
    for (const s of [SEALED, 'kalshi-read-key', 'PRIVATE KEY']) expect(json).not.toContain(s);
  });

  it('the display shows them, read only; withdrawn consent hides them', async () => {
    const { displayHtml, setConnections } = await web();
    setConnections((await me(EDGE.connections, {})).connections);
    const shown = text(displayHtml(display, { titles: new Map() }));
    expect(shown).toMatch(/^Your account as of \d{1,2}:\d\d/);
    expect(shown).toContain('Kalshi read only');
    expect(shown).toMatch(/\$[\d,]+\.\d\d Balance · \d open positions?/);
    expect(shown).toMatch(/[+−]?\$[\d,]+\.\d\d today/);
    expect(shown).not.toMatch(/\b(buy|sell|order|bet|trade)\b/i);

    await me(EDGE.consent, { params: { connection_id: con.connection_id }, body: { share_numbers: false } });
    setConnections((await me(EDGE.connections, {})).connections);
    const hidden = text(displayHtml(display, { titles: new Map() }));
    expect(hidden).not.toContain('$');
    expect(hidden).toContain('Turn on "Let my widgets use its numbers" in Accounts');
  });

  it("edge has no route that could trade or move money", () => {
    const paths = Object.values(EDGE).map((e) => (e as { path: string }).path);
    expect(paths.filter((p) => /order|trade|withdraw|transfer|deposit/i.test(p))).toEqual([]);
  });
});
