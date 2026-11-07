import { createHash } from 'node:crypto';
import { ACCOUNTS, DEFAULT_LOOK, newId, type Account, type Look } from '@app/contracts';
import { HttpError, MemoryBus, now, type Bus, type Handlers } from '@app/service-kit';

export interface FakeDeps {
  bus?: Bus;
}
export async function fakeDepsFromEnv(): Promise<FakeDeps> {
  return {};
}

/**
 * In-memory accounts. Sessions are opaque `fake.<session_id>.<account_id>` strings, not signed JWTs: the real
 * accounts signs Ed25519 JWTs (SessionClaims). The fake keeps password hashes only so it behaves like the real one.
 */
export function fake(deps: FakeDeps = {}): Handlers<typeof ACCOUNTS> {
  const bus = deps.bus ?? new MemoryBus();
  const accounts = new Map<string, Account>();
  const byEmail = new Map<string, { account_id: string; pw: string }>();
  const sessions = new Map<string, { account_id: string; revoked: boolean }>();
  const pwHash = (p: string) => createHash('sha256').update(`fake-salt:${p}`).digest('hex');

  function session(account_id: string) {
    const session_id = newId('ses');
    sessions.set(session_id, { account_id, revoked: false });
    return { session_id, token: `fake.${session_id}.${account_id}`, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() };
  }
  function create(email: string | null): Account {
    const a: Account = { account_id: newId('acc'), email, plan: 'free', guest: email === null, look: { ...DEFAULT_LOOK }, created_at: now() };
    accounts.set(a.account_id, a);
    return a;
  }
  const mustGet = (id: string) => {
    const a = accounts.get(id);
    if (!a) throw new HttpError(404, 'not_found', 'no such account');
    return a;
  };

  return {
    signup: ({ body }) => {
      if (byEmail.has(body.email)) throw new HttpError(409, 'exists', 'that email has an account');
      const account = create(body.email);
      byEmail.set(body.email, { account_id: account.account_id, pw: pwHash(body.password) });
      return { account, session: session(account.account_id) };
    },
    guest: () => {
      const account = create(null);
      return { account, session: session(account.account_id) };
    },
    login: ({ body }) => {
      const u = byEmail.get(body.email);
      if (!u || u.pw !== pwHash(body.password)) throw new HttpError(401, 'bad_login', 'wrong email or password');
      return { account: mustGet(u.account_id), session: session(u.account_id) };
    },
    logout: ({ params }) => {
      const s = sessions.get(params.session_id);
      if (!s) throw new HttpError(404, 'not_found', 'no such session');
      s.revoked = true;
      return { ok: true };
    },
    sessionValid: ({ params }) => {
      const s = sessions.get(params.session_id);
      return { session_id: params.session_id, valid: !!s && !s.revoked };
    },
    get: ({ params }) => mustGet(params.account_id),
    setLook: async ({ params, body }) => {
      const a = mustGet(params.account_id);
      a.look = body as Look;
      await bus.emit('look.changed', { account_id: a.account_id, at: now(), look: a.look });
      return a.look;
    },
  };
}
