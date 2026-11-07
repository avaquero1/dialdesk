import { ACCOUNTS, AGENT, AUDIT, BOARD, CONNECTIONS, EDGE, MODELS, SESSION_COOKIE, type ServiceName } from '@app/contracts';
import { ContractError, HttpError, type Call, type Handlers } from '@app/service-kit';

export type Upstream = Extract<ServiceName, 'accounts' | 'board' | 'agent' | 'connections' | 'audit' | 'models'>;
export type Deps = Partial<Record<Upstream, Call>>;

/** The session cookie: HttpOnly, Secure, SameSite=Strict, Path=/, living as long as the session. */
export function sessionCookie(token: string, expiresAt: string | null, clock: () => number = Date.now): string {
  const maxAge = expiresAt ? Math.max(0, Math.floor((Date.parse(expiresAt) - clock()) / 1000)) : 0;
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export interface RouteHooks {
  /** After accounts revoked the session (the real edge drops it from its cache and closes its sockets). */
  onLogout?: (sessionId: string) => void;
  clock?: () => number;
}

/**
 * edge's browser API: each call goes to the service behind it through the typed clients, so both sides are
 * contract-checked. The account id always comes from the session, never from the browser. Shared by the fake and
 * the real edge; they differ in the session check and the middleware around it.
 */
export function routes(deps: Deps, hooks: RouteHooks = {}): Handlers<typeof EDGE> {
  const clock = hooks.clock ?? Date.now;
  const need = (s: Upstream): Call => {
    const c = deps[s];
    if (!c) throw new HttpError(503, 'no_upstream', `${s} is not wired`);
    return c;
  };
  const acc = (ctx: { accountId: string | null }) => {
    if (!ctx.accountId) throw new HttpError(401, 'unauthorized', 'no session');
    return ctx.accountId;
  };

  return {
    signup: async ({ body }, ctx) => {
      const r = await need('accounts')(ACCOUNTS.signup, { body });
      await need('board')(BOARD.createDefaults, { params: { account_id: r.account.account_id }, body: { category: 'sports' } });
      ctx.setHeader('set-cookie', sessionCookie(r.session.token, r.session.expires_at, clock));
      return { account: r.account };
    },
    guest: async (_i, ctx) => {
      const r = await need('accounts')(ACCOUNTS.guest, { body: {} });
      await need('board')(BOARD.createDefaults, { params: { account_id: r.account.account_id }, body: { category: 'sports' } });
      ctx.setHeader('set-cookie', sessionCookie(r.session.token, r.session.expires_at, clock));
      return { account: r.account };
    },
    login: async ({ body }, ctx) => {
      const r = await need('accounts')(ACCOUNTS.login, { body });
      ctx.setHeader('set-cookie', sessionCookie(r.session.token, r.session.expires_at, clock));
      return { account: r.account };
    },
    logout: async (_i, ctx) => {
      if (ctx.sessionId) {
        await need('accounts')(ACCOUNTS.logout, { params: { session_id: ctx.sessionId } });
        hooks.onLogout?.(ctx.sessionId);
      }
      ctx.setHeader('set-cookie', sessionCookie('', null));
      return { ok: true };
    },
    me: (_i, ctx) => need('accounts')(ACCOUNTS.get, { params: { account_id: acc(ctx) } }),
    board: (_i, ctx) => need('board')(BOARD.getBoard, { params: { account_id: acc(ctx) } }),
    setLayout: ({ body }, ctx) => need('board')(BOARD.setLayout, { params: { account_id: acc(ctx) }, body }),
    chat: ({ body }, ctx) => need('agent')(AGENT.chat, { body: { ...body, account_id: acc(ctx) } }),
    conversation: ({ params }, ctx) => need('agent')(AGENT.getConversation, { params, query: { account_id: acc(ctx) } }),
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
    connect: async ({ body }, ctx) => {
      // Opaque: edge never reads, logs or echoes this body (the private key inside is sealed to connections). It only
      // sets account_id from the session, last, so a browser can't name another account. connections checks the rest.
      try {
        return await need('connections')(CONNECTIONS.connect, { body: { ...body, account_id: acc(ctx) } as never });
      } catch (err) {
        if (err instanceof ContractError) throw new HttpError(400, 'bad_request', 'not a connect body');
        throw err;
      }
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
}
