/**
 * Milestone D1.2, end to end: a visitor taps "Try it" and gets the prescribed first board with prices at once (first
 * paint, before any run). The nightly sweep deletes the guest, and with it the board, the conversation and the
 * connection, and the audit log counts it. The real edge, the real accounts (memory store) and the real agent, with
 * board, connections, markets, models and audit as fakes. One in-process bus carries account.deleted the way Valkey
 * does, and every log row goes to audit the way its stream reader does. No Docker, no model call.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, AGENT, AUDIT, BOARD, CONNECTIONS, MARKETS, MODELS, type Board, type ChatReply, type LogEntry } from '@app/contracts';
import { MemoryBus, buildApp, createClient, createLogger, followAccountDeletes, type AccountData } from '@app/service-kit';
import { fakeApp, testCallers, TEST_TOKENS } from '@app/testkit';
import { scheduleGuestSweep } from '../services/accounts/src/real.ts';
import { realAccounts } from '../services/accounts/test/helpers.ts';
import { createReal as agentReal } from '../services/agent/src/real.ts';
import { MemoryConversationStore } from '../services/agent/src/store.ts';
import { createFakeAudit } from '../services/audit/src/fake.ts';
import { MAX_WIDGETS } from '../services/board/src/logic.ts';
import { fake as board } from '../services/board/src/fake.ts';
import { fake as connections } from '../services/connections/src/fake.ts';
import { inProcess } from '../services/edge/src/fake.ts';
import { createRealEdge } from '../services/edge/src/real.ts';
import { sessionKeys } from '../services/edge/src/session.ts';
import { fake as markets } from '../services/markets/src/fake.ts';
import { fake as models } from '../services/models/src/fake.ts';

const ORIGIN = 'https://vultrcontest.vaquerothe.dev';
const silent = createLogger('e2e', 'silent');
const audit = createFakeAudit();

/** The bus every service shares here: events reach subscribers, log rows reach audit (as from log:actions). */
class LoggedBus extends MemoryBus {
  override async log(entry: LogEntry) {
    await super.log(entry);
    audit.append(entry);
  }
}
const bus = new LoggedBus();

type App = { fetch: (r: Request) => Response | Promise<Response> };
const as = (caller: keyof typeof TEST_TOKENS, app: App) =>
  createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });

const accounts = realAccounts({ bus });
const marketsApp = fakeApp('markets', MARKETS, markets());
let boardData!: AccountData;
let connData!: AccountData;
const apps = {
  accounts: accounts.app,
  board: fakeApp('board', BOARD, board({ bus, markets: as('board', marketsApp), enqueue: () => {}, accountData: (d) => (boardData = d) })),
  connections: fakeApp('connections', CONNECTIONS, connections({ accountData: (d) => (connData = d) })),
  models: fakeApp('models', MODELS, models()),
  audit: fakeApp('audit', AUDIT, audit.handlers),
};
const conversations = new MemoryConversationStore();
const agentApp = buildApp({
  service: 'agent',
  mode: 'real',
  api: AGENT,
  handlers: agentReal({ models: as('agent', apps.models), board: as('agent', apps.board), markets: as('agent', marketsApp), store: conversations, bus }),
  callers: testCallers(),
  log: silent,
});
const t = TEST_TOKENS.edge;
/** edge trusts accounts' "session valid" answer for 15 s; `skew` moves edge's clock past that. */
let skew = 0;
const edge = createRealEdge({
  clock: () => Date.now() + skew,
  deps: inProcess({ ...apps, agent: agentApp }, { accounts: t, board: t, agent: t, connections: t, audit: t, models: t }),
  keys: sessionKeys(accounts.key.publicKey),
  origins: [ORIGIN],
  log: silent,
  trustProxy: true,
});

/** A visitor's browser on our page (its own cookie and address). */
function visitor(ip: string) {
  let cookie: string | null = null;
  return async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const headers: Record<string, string> = { origin: ORIGIN, 'x-forwarded-for': ip };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await edge.app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return { status: res.status, data: (await res.json()) as T };
  };
}

// board, agent and connections follow account deletes, each asking accounts (as itself) about orphans.
const follow = (service: 'board' | 'agent' | 'connections', data: AccountData) =>
  followAccountDeletes({ service, bus, data, accounts: as(service, accounts.app), log: silent, everyMs: 0 });
const followers = await Promise.all([follow('board', boardData), follow('agent', conversations), follow('connections', connData)]);
afterAll(async () => {
  for (const f of followers) await f.stop();
});

/** The sweep at 08:00 UTC on a clock two hours ahead, so every guest made in this test is old enough. */
const sweepNow = async () => {
  const ahead = () => Date.now() + 2 * 3600_000;
  const s = scheduleGuestSweep(accounts.store, silent, bus, new Date(ahead()).getUTCHours(), ahead);
  const n = await s.tick();
  s.stop();
  await Promise.all(followers.map((f) => f.idle()));
  return n;
};

/** A guest who taps Try it, chats once and connects a public wallet. */
async function tryIt(ip: string) {
  const b = visitor(ip);
  const started = Date.now();
  const g = await b<{ account: { account_id: string; guest: boolean } }>('POST', '/api/guest', {});
  expect(g.status).toBe(201);
  const ms = Date.now() - started;
  const account_id = g.data.account.account_id;
  const board = await b<Board>('GET', '/api/board');
  const chat = await b<ChatReply>('POST', '/api/chat', { conversation_id: null, widget_id: null, message: 'Hi' });
  expect(chat.status).toBe(200);
  const conn = await b<{ connection_id: string }>('POST', '/api/connections', { exchange: 'polymarket', wallet: `0x${'ab'.repeat(20)}` });
  expect(conn.status).toBe(201);
  return { b, account_id, guest: g.data.account.guest, ms, board: board.data, conversation_id: chat.data.conversation_id };
}

const call = {
  account: (id: string) => as('edge', accounts.app)(ACCOUNTS.get, { params: { account_id: id } }),
  board: (id: string) => as('edge', apps.board)(BOARD.getBoard, { params: { account_id: id } }),
  conversation: (cnv: string, id: string) => as('edge', agentApp)(AGENT.getConversation, { params: { conversation_id: cnv as never }, query: { account_id: id } }),
  connections: (id: string) => as('edge', apps.connections)(CONNECTIONS.list, { query: { account_id: id } }),
};
const gone = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ status: 404 });

describe('Milestone D1.2: "Try it", and gone the next night', () => {
  it('a visitor taps Try it and gets the prescribed first board with prices, then the sweep deletes everything they made', async () => {
    const g = await tryIt('198.51.100.21');
    expect(g.guest).toBe(true);
    expect(g.ms).toBeLessThan(5000);
    // The prescribed first board (N1.1.1's defaults), with first-paint prices before any run.
    const displays = g.board.widgets.filter((w) => w.spec.kind === 'display');
    expect(displays.length).toBeGreaterThan(0);
    expect(g.board.widgets.length).toBeLessThanOrEqual(MAX_WIDGETS);
    const priced = displays.filter((w) => (w.quotes ?? []).length > 0);
    expect(priced.length).toBeGreaterThan(0);
    expect(priced[0]!.quotes![0]).toMatchObject({ market_id: expect.any(String) });
    expect((await call.conversation(g.conversation_id, g.account_id)).turns.length).toBeGreaterThan(0);
    expect((await call.connections(g.account_id)).connections).toHaveLength(1);

    const before = await as('edge', apps.audit)(AUDIT.trust, { query: { account_id: g.account_id } });
    expect(await sweepNow()).toBeGreaterThanOrEqual(1);

    await gone(call.account(g.account_id));
    await gone(call.board(g.account_id));
    await gone(call.conversation(g.conversation_id, g.account_id));
    expect((await call.connections(g.account_id)).connections).toEqual([]);
    // The old session no longer opens anything, once edge's 15 s cache of "valid" runs out.
    skew += 16_000;
    expect((await g.b('GET', '/api/board')).status).toBe(401);

    // The audit log counts it: account.deleted from accounts, and each service's own deletion row.
    const rows = audit.rows.filter((r) => r.entry.account_id === g.account_id).map((r) => `${r.entry.service}:${r.entry.action}`);
    expect(rows).toEqual(expect.arrayContaining(['accounts:account.deleted', 'board:account.data_deleted', 'agent:account.data_deleted', 'connections:account.data_deleted']));
    const after = await as('edge', apps.audit)(AUDIT.trust, { query: { account_id: g.account_id } });
    expect(after.site.guests_deleted).toBeGreaterThan(before.site.guests_deleted);
    expect((await as('edge', apps.audit)(AUDIT.verify, { query: {} })).ok).toBe(true);
  });

  it('a service that was down during the sweep deletes the guest at its next orphan sweep', async () => {
    const g = await tryIt('198.51.100.22');
    // agent misses the event: it isn't listening during the sweep.
    const agentFollower = followers[1]!;
    await agentFollower.stop();
    await sweepNow();
    await gone(call.board(g.account_id));
    expect((await call.conversation(g.conversation_id, g.account_id)).turns.length).toBeGreaterThan(0);

    const back = await follow('agent', conversations);
    followers[1] = back;
    expect(await back.sweepOrphans()).toBe(1);
    await gone(call.conversation(g.conversation_id, g.account_id));
    // A signed-up account is never an orphan.
    expect(await back.sweepOrphans()).toBe(0);
  });
});
