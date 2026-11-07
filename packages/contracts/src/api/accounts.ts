import { z } from 'zod';
import { AccountId, Ok, SessionId, Timestamp } from '../common.ts';
import { api } from '../endpoint.ts';
import { Look } from '../look.ts';

export const Plan = z.enum(['free', 'pro']).describe('shown, not billed');
export const Email = z.email().max(254);
export const Password = z.string().min(10).max(200);

/** The session JWT's claims (Ed25519, signed by accounts, checked by edge with the public key). */
export const SessionClaims = z
  .object({
    sub: AccountId,
    sid: SessionId,
    plan: Plan,
    guest: z.boolean(),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .strict();
export type SessionClaims = z.infer<typeof SessionClaims>;

export const Session = z
  .object({ session_id: SessionId, token: z.string().describe('the JWT; edge puts it in an HttpOnly cookie'), expires_at: Timestamp })
  .strict();

export const Account = z
  .object({
    account_id: AccountId,
    email: Email.nullable().describe('null for a guest'),
    plan: Plan,
    guest: z.boolean(),
    look: Look,
    created_at: Timestamp,
  })
  .strict();
export type Account = z.infer<typeof Account>;

export const SignedIn = z.object({ account: Account, session: Session }).strict();

const accountParams = z.object({ account_id: AccountId });

export const ACCOUNTS = api('accounts', {
  signup: {
    method: 'POST',
    path: '/accounts',
    callers: ['edge'],
    body: z.object({ email: Email, password: Password }).strict(),
    response: SignedIn,
    status: 201,
    errors: [400, 409],
    summary: 'Create an account and its first session.',
  },
  guest: {
    method: 'POST',
    path: '/guests',
    callers: ['edge'],
    body: z.object({}).strict(),
    response: SignedIn,
    status: 201,
    errors: [429],
    summary: '"Try it": a guest account, deleted nightly.',
  },
  login: {
    method: 'POST',
    path: '/sessions',
    callers: ['edge'],
    body: z.object({ email: Email, password: Password }).strict(),
    response: SignedIn,
    status: 201,
    errors: [400, 401, 429],
    summary: 'Log in.',
  },
  logout: {
    method: 'DELETE',
    path: '/sessions/:session_id',
    callers: ['edge'],
    params: z.object({ session_id: SessionId }),
    response: Ok,
    errors: [404],
    summary: 'Revoke a session.',
  },
  sessionValid: {
    method: 'GET',
    path: '/sessions/:session_id',
    callers: ['edge'],
    params: z.object({ session_id: SessionId }),
    response: z.object({ session_id: SessionId, valid: z.boolean() }).strict(),
    summary: 'Is a session still valid (not revoked)? edge caches this briefly.',
  },
  get: {
    method: 'GET',
    path: '/accounts/:account_id',
    callers: ['edge'],
    params: accountParams,
    response: Account,
    errors: [404],
    summary: 'Read an account and its settings.',
  },
  setLook: {
    method: 'PUT',
    path: '/accounts/:account_id/look',
    callers: ['edge'],
    params: accountParams,
    body: Look,
    response: Look,
    errors: [400, 404],
    summary: 'Save the look (validated again here). Emits look.changed.',
  },
});
