import { getCookie } from 'hono/cookie';
import {
  ACCOUNTS,
  AGENT,
  AUDIT,
  BOARD,
  CONNECTIONS,
  ConnectBody,
  EDGE,
  MODELS,
  SESSION_COOKIE,
  type ServiceName,
} from '@app/contracts';
import { HttpError, clientFromEnv, createClient, type Call, type Handlers, type SessionCheck } from '@app/service-kit';

export type FakeDeps = Partial<Record<Extract<ServiceName, 'accounts' | 'board' | 'agent' | 'connections' | 'audit' | 'models'>, Call>>;

export async function fakeDepsFromEnv(): Promise<FakeDeps> {
  const out: FakeDeps = {};
  for (const s of ['accounts', 'board', 'agent', 'connections', 'audit', 'models'] as const) out[s] = await clientFromEnv('edge', s);
  return out;
}

const cookie = (token: string, maxAge: number) =>
  `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

/**
 * A thin edge: routes each browser call to the service behind it (through the typed clients, so both sides are
 * contract-checked). The fake sessions are accounts' fake tokens "fake.<session_id>.<account_id>"; the real edge
 * verifies Ed25519 JWTs with accounts' public key, rate limits, and serves the /live WebSocket.
 */
export function createFakeEdge(deps: FakeDeps) {
  const need = (s: keyof FakeDeps): Call => {
    const c = deps[s];
    if (!c) throw new HttpError(503, 'no_upstream', `${s} is not wired`);
    return c;
  };

  const sessionCheck: SessionCheck = async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const m = token && /^fake\.(ses_[A-Za-z0-9]+)\.(acc_[A-Za-z0-9]+)$/.exec(token);
    if (!m) return null;
    const v = await need('accounts')(ACCOUNTS.sessionValid, { params: { session_id: m[1]! } });
    return v.valid ? { sessionId: m[1]!, accountId: m[2]! } : null;
  };

  const acc = (ctx: { accountId: string | null }) => {
    if (!ctx.accountId) throw new HttpError(401, 'unauthorized', 'no session');
    return ctx.accountId;
  };

  const handlers: Handlers<typeof EDGE> = {
    signup: async ({ body }, ctx) => {
      const r = await need('accounts')(ACCOUNTS.signup, { body });
      await need('board')(BOARD.createDefaults, { params: { account_id: r.account.account_id }, body: { category: 'sports' } });
      ctx.setHeader('set-cookie', cookie(r.session.token, 7 * 86400));
      return { account: r.account };
    },
    guest: async (_i, ctx) => {
      const r = await need('accounts')(ACCOUNTS.guest, { body: {} });
      await need('board')(BOARD.createDefaults, { params: { account_id: r.account.account_id }, body: { category: 'sports' } });
      ctx.setHeader('set-cookie', cookie(r.session.token, 86400));
      return { account: r.account };
    },
    login: async ({ body }, ctx) => {
      const r = await need('accounts')(ACCOUNTS.login, { body });
      ctx.setHeader('set-cookie', cookie(r.session.token, 7 * 86400));
      return { account: r.account };
    },
    logout: async (_i, ctx) => {
      if (ctx.sessionId) await need('accounts')(ACCOUNTS.logout, { params: { session_id: ctx.sessionId } });
      ctx.setHeader('set-cookie', cookie('', 0));
      return { ok: true };
    },
    me: (_i, ctx) => need('accounts')(ACCOUNTS.get, { params: { account_id: acc(ctx) } }),
    board: (_i, ctx) => need('board')(BOARD.getBoard, { params: { account_id: acc(ctx) } }),
    setLayout: ({ body }, ctx) => need('board')(BOARD.setLayout, { params: { account_id: acc(ctx) }, body }),
    chat: ({ body }, ctx) => need('agent')(AGENT.chat, { body: { ...body, account_id: acc(ctx) } }),
    accept: ({ params }, ctx) => need('board')(BOARD.accept, { params, body: { account_id: acc(ctx) } }),
    reject: ({ params }, ctx) => need('board')(BOARD.reject, { params, body: { account_id: acc(ctx) } }),
    resize: ({ params, body }, ctx) => need('board')(BOARD.resize, { params, body: { ...body, account_id: acc(ctx) } }),
    clear: ({ params }, ctx) => need('board')(BOARD.clear, { params, body: { account_id: acc(ctx) } }),
    remove: ({ params }, ctx) => need('board')(BOARD.remove, { params, query: { account_id: acc(ctx) } }),
    refresh: ({ params }, ctx) => need('board')(BOARD.refresh, { params, body: { account_id: acc(ctx) } }),
    addSource: ({ params, body }, ctx) => need('board')(BOARD.addSource, { params, body: { ...body, account_id: acc(ctx) } }),
    trace: ({ params }, ctx) => need('board')(BOARD.getTrace, { params, query: { account_id: acc(ctx) } }),
    receipt: ({ params }, ctx) => need('board')(BOARD.getReceipt, { params, query: { account_id: acc(ctx) } }),
    setLook: ({ body }, ctx) => need('accounts')(ACCOUNTS.setLook, { params: { account_id: acc(ctx) }, body }),
    connectionsKey: () => need('connections')(CONNECTIONS.publicKey, {}),
    connections: (_i, ctx) => need('connections')(CONNECTIONS.list, { query: { account_id: acc(ctx) } }),
    connect: ({ body }, ctx) => {
      // Opaque in the real edge (passed unread, body logging off). The fake only adds the account id.
      const parsed = ConnectBody.safeParse({ ...body, account_id: acc(ctx) });
      if (!parsed.success) throw new HttpError(400, 'bad_request', 'not a connect body');
      return need('connections')(CONNECTIONS.connect, { body: parsed.data });
    },
    consent: ({ params, body }, ctx) =>
      need('connections')(CONNECTIONS.setConsent, { params: { connection_id: params.connection_id as never }, body: { ...body, account_id: acc(ctx) } }),
    disconnect: ({ params }, ctx) =>
      need('connections')(CONNECTIONS.remove, { params: { connection_id: params.connection_id as never }, query: { account_id: acc(ctx) } }),
    trust: async (_i, ctx) => ({
      counts: await need('audit')(AUDIT.trust, { query: { account_id: acc(ctx) } }),
      spend: await need('models')(MODELS.spend, { query: { account_id: acc(ctx) } }),
    }),
    auditHead: () => need('audit')(AUDIT.head, {}),
    auditVerify: () => need('audit')(AUDIT.verify, { query: {} }),
  };
  return { handlers, sessionCheck };
}

export function fake(deps: FakeDeps = {}): Handlers<typeof EDGE> {
  return createFakeEdge(deps).handlers;
}

/** In-process wiring for tests: each dep is another service's fake app. */
export function inProcess(apps: Partial<Record<keyof FakeDeps, { fetch: (r: Request) => Response | Promise<Response> }>>, tokens: Partial<Record<keyof FakeDeps, string>>): FakeDeps {
  const out: FakeDeps = {};
  for (const [s, app] of Object.entries(apps) as [keyof FakeDeps, { fetch: (r: Request) => Response | Promise<Response> }][])
    out[s] = createClient({ baseUrl: `http://${s}.internal`, token: tokens[s], fetch: (r) => app.fetch(r) });
  return out;
}
