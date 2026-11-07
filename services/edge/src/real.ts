import type { IncomingMessage, Server } from 'node:http';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { parse as parseCookies } from 'hono/utils/cookie';
import { ACCOUNTS, EDGE, SESSION_COOKIE } from '@app/contracts';
import { buildApp, type Handlers, type Logger, type SessionCheck } from '@app/service-kit';
import { LocalBus, type EventFeed } from './feed.ts';
import { attachLive, type Live, type LiveSession } from './live.ts';
import { DEFAULT_LIMITS, RateLimiter, type Limits } from './ratelimit.ts';
import { routes, type Deps } from './routes.ts';
import { RevocationCache, verifySession, type SessionKeys } from './session.ts';

export interface RealEdgeOptions {
  deps: Deps;
  /** accounts' public key(s): edge holds no private key. */
  keys: SessionKeys;
  /** Exact origins for state-changing calls and the /live handshake, e.g. https://vultrcontest.vaquerothe.dev. */
  origins: string[];
  /** Behind caddy: take the client address from the last X-Forwarded-For entry (caddy replaces what the client sent). */
  trustProxy?: boolean;
  limits?: Partial<Limits>;
  feed?: EventFeed;
  log: Logger;
  clock?: () => number;
  /** How long accounts' "still valid" answer is trusted. */
  revalidateMs?: number;
  /** Request bodies over this are refused with 413 before they're read. */
  maxBody?: number;
  strictResponses?: boolean;
  live?: { maxPerAccount?: number; recheckMs?: number; heartbeatMs?: number };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_SESSION_SEC = 8 * 86400;

/** Route-specific buckets: [method, path pattern, rule, keyed by account when signed in]. */
const ROUTE_LIMITS: [string, RegExp, keyof Limits, boolean][] = [
  ['POST', /^\/api\/signup$/, 'signup', false],
  ['POST', /^\/api\/login$/, 'login', false],
  ['POST', /^\/api\/guest$/, 'guest', false],
  ['POST', /^\/api\/chat$/, 'chat', true],
  ['POST', /^\/api\/widgets\/[^/]+\/refresh$/, 'refresh', true],
];

export function checkOrigins(list: string[]): Set<string> {
  for (const o of list) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new Error(`EDGE_ALLOWED_ORIGINS: "${o}" is not a URL`);
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.origin !== o || (u.protocol !== 'https:' && !(local && u.protocol === 'http:')))
      throw new Error(`EDGE_ALLOWED_ORIGINS: "${o}" must be an exact https origin (http only for localhost), no path or slash`);
  }
  if (!list.length) throw new Error('EDGE_ALLOWED_ORIGINS is empty');
  return new Set(list);
}

/**
 * The real edge: Ed25519 session check on every browser route, then accounts' revocation answer (cached briefly);
 * an exact-Origin check on every state-changing call; rate limits per address and per account; a body cap; and
 * /live (attach it to the HTTP server). Routing is routes.ts, the same as the fake.
 */
export function createRealEdge(o: RealEdgeOptions) {
  const clock = o.clock ?? Date.now;
  const nowSec = () => Math.floor(clock() / 1000);
  const origins = checkOrigins(o.origins);
  const limiter = new RateLimiter({ ...DEFAULT_LIMITS, ...o.limits }, clock);
  const feed = o.feed ?? new LocalBus();
  const revocation = new RevocationCache(
    async (sid) => {
      if (!o.deps.accounts) throw new Error('accounts is not wired');
      return (await o.deps.accounts(ACCOUNTS.sessionValid, { params: { session_id: sid } })).valid;
    },
    o.revalidateMs ?? 15_000,
    clock,
  );
  let live: Live | null = null;

  async function authenticate(token: string | undefined): Promise<LiveSession | null> {
    const claims = verifySession(token, o.keys, nowSec());
    if (!claims) return null;
    if (!(await revocation.valid(claims.sid, claims.exp))) return null;
    return { accountId: claims.sub, sessionId: claims.sid, exp: claims.exp };
  }
  const sessionCheck: SessionCheck = async (c) => authenticate(getCookie(c, SESSION_COOKIE));

  const handlers: Handlers<typeof EDGE> = routes(o.deps, {
    clock,
    onLogout: (sid) => {
      revocation.revoke(sid, nowSec() + MAX_SESSION_SEC);
      live?.closeSession(sid);
    },
  });

  const ipOf = (xff: string | undefined, socketAddr: string | undefined) => {
    if (o.trustProxy && xff) return xff.split(',').at(-1)!.trim() || 'unknown';
    return socketAddr ?? 'unknown';
  };
  const clientIp = (c: Context) => {
    let addr: string | undefined;
    try {
      addr = getConnInfo(c).remote.address;
    } catch {
      addr = undefined; // app.request() in tests has no socket
    }
    return ipOf(c.req.header('x-forwarded-for'), addr);
  };
  const tooMany = (c: Context, retryAfter: number) => {
    c.header('retry-after', String(retryAfter));
    return c.json({ error: 'rate_limited', message: 'too many requests; slow down' }, 429);
  };

  const inner = buildApp({
    service: 'edge',
    mode: 'real',
    api: EDGE,
    handlers,
    // No service calls edge: every route is `browser` or `public`.
    callers: new Map(),
    log: o.log,
    sessionCheck,
    strictResponses: o.strictResponses,
  });

  const app = new Hono();
  app.onError((err, c) => {
    o.log.error({ err: err.message, path: c.req.path }, 'edge: request failed');
    return c.json({ error: 'unavailable', message: 'try again shortly' }, 503);
  });
  app.notFound((c) => c.json({ error: 'not_found', message: 'no such route' }, 404));
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('cache-control', 'no-store');
    c.res.headers.set('x-content-type-options', 'nosniff');
  });
  app.use(
    '/api/*',
    bodyLimit({ maxSize: o.maxBody ?? 64 * 1024, onError: (c) => c.json({ error: 'too_large', message: 'request body too large' }, 413) }),
  );
  // CSRF, second layer after SameSite=Strict: a state-changing call must come from our own page.
  app.use('/api/*', async (c, next) => {
    if (SAFE.has(c.req.method)) return next();
    const origin = c.req.header('origin');
    if (!origin || !origins.has(origin) || c.req.header('sec-fetch-site') === 'cross-site')
      return c.json({ error: 'forbidden', message: 'cross-origin request refused' }, 403);
    return next();
  });
  app.use('/api/*', async (c, next) => {
    const ip = clientIp(c);
    const a = limiter.take('address', ip);
    if (!a.ok) return tooMany(c, a.retryAfter);
    // Signature only (cheap, no upstream call): enough to key the bucket. The route's own check does the rest.
    const sub = verifySession(getCookie(c, SESSION_COOKIE), o.keys, nowSec())?.sub ?? null;
    if (sub) {
      const b = limiter.take('account', sub);
      if (!b.ok) return tooMany(c, b.retryAfter);
    }
    const route = ROUTE_LIMITS.find(([m, re]) => m === c.req.method && re.test(c.req.path));
    if (route) {
      const r = limiter.take(route[2], route[3] && sub ? sub : ip);
      if (!r.ok) return tooMany(c, r.retryAfter);
    }
    return next();
  });
  app.route('/', inner);

  return {
    app,
    handlers,
    sessionCheck,
    authenticate,
    /** Serve /live on this HTTP server. */
    attach(server: Server): Live {
      live = attachLive(server, {
        origins,
        feed,
        log: o.log,
        clock,
        ...o.live,
        authenticate: (cookie) => authenticate(cookie ? parseCookies(cookie, SESSION_COOKIE)[SESSION_COOKIE] : undefined),
        stillValid: (s) => revocation.valid(s.sessionId, s.exp),
        allow: (req: IncomingMessage) => {
          const ip = ipOf(req.headers['x-forwarded-for'] as string | undefined, req.socket.remoteAddress);
          return limiter.take('address', ip).ok && limiter.take('live', ip).ok;
        },
      });
      return live;
    },
  };
}
export type RealEdge = ReturnType<typeof createRealEdge>;
