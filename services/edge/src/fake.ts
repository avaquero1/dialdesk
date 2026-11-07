import { getCookie } from 'hono/cookie';
import { ACCOUNTS, EDGE, SESSION_COOKIE } from '@app/contracts';
import { HttpError, clientFromEnv, createClient, type Handlers, type SessionCheck } from '@app/service-kit';
import { routes, type Deps } from './routes.ts';

export type FakeDeps = Deps;

export async function depsFromEnv(): Promise<FakeDeps> {
  const out: FakeDeps = {};
  for (const s of ['accounts', 'board', 'agent', 'connections', 'audit', 'models'] as const) out[s] = await clientFromEnv('edge', s);
  return out;
}

/**
 * The fake edge: the real routes (routes.ts) with a fake session check. Fake sessions are accounts' fake tokens
 * "fake.<session_id>.<account_id>"; the real edge (real.ts) verifies Ed25519 JWTs, rate limits and serves /live.
 */
export function createFakeEdge(deps: FakeDeps) {
  const sessionCheck: SessionCheck = async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const m = token && /^fake\.(ses_[A-Za-z0-9]+)\.(acc_[A-Za-z0-9]+)$/.exec(token);
    if (!m) return null;
    if (!deps.accounts) throw new HttpError(503, 'no_upstream', 'accounts is not wired');
    const v = await deps.accounts(ACCOUNTS.sessionValid, { params: { session_id: m[1]! } });
    return v.valid ? { sessionId: m[1]!, accountId: m[2]! } : null;
  };
  return { handlers: routes(deps), sessionCheck };
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
/** The Phase 0 name. */
export const fakeDepsFromEnv = depsFromEnv;
