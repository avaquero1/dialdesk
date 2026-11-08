import { z } from 'zod';
import { AccountId, AuditRowId, ConnectionId, Exchange, Timestamp } from '../common.ts';
import { api } from '../endpoint.ts';
import { LogEntry } from '../bus.ts';

export const SignedHead = z
  .object({
    seq: z.number().int().min(0),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    signed_at: Timestamp,
    alg: z.literal('Ed25519'),
    key_id: z.string(),
    signature: z.string().describe('base64'),
    pushed_at: Timestamp.nullable().describe('when this head reached the write-once bucket'),
  })
  .strict();

export const AuditRow = z
  .object({
    row_id: AuditRowId,
    seq: z.number().int().min(0),
    prev_hash: z.string().regex(/^[0-9a-f]{64}$/),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    entry: LogEntry,
  })
  .strict();

/**
 * The log actions the trust page counts. Each service logs them with `bus.log(logEntry(...))`; audit counts rows per
 * account and UTC day (consents and connections: all time).
 * - `sandbox.created` / `sandbox.destroyed` / `sandbox.killed`: subject_id = the sandbox id.
 * - `proxy.refused`: one row per job with `sizes.requests` = how many requests the proxy refused (a row without it counts 1).
 * - `run.poisoned`: subject_id = the widget, `ids.sandbox_id`.
 * - `connection.scope_checked`: subject_id = the connection id, `ids.exchange`, `ids.scope` (e.g. "read"), outcome `ok` when the
 *   scope was proven, `refused` when the key was refused; `hashes.key_fingerprint`, never the key. `connection.removed` ends it.
 * - `consent.<what>`: every consent the user gave, subject_id = what it is about.
 * - `account.created` (a sign-up), `account.guest_created`, `account.deleted` (a swept guest, subject_id = the account,
 *   `ids.reason` = "guest_sweep") and `login.refused` (wrong email or password, or locked: `ids.reason`, `hashes.email`;
 *   account_id only when the email has an account): counted for the whole site per UTC day (`site`), never per email.
 */
export const TRUST_ACTIONS = {
  sandboxCreated: 'sandbox.created',
  sandboxDestroyed: 'sandbox.destroyed',
  sandboxKilled: 'sandbox.killed',
  proxyRefused: 'proxy.refused',
  runPoisoned: 'run.poisoned',
  connectionChecked: 'connection.scope_checked',
  connectionRemoved: 'connection.removed',
  consentPrefix: 'consent.',
  accountCreated: 'account.created',
  guestCreated: 'account.guest_created',
  accountDeleted: 'account.deleted',
  loginRefused: 'login.refused',
} as const;

/** The site's account numbers for the day (UTC): counts only, no ids. */
export const TrustSiteCounts = z
  .object({
    signups: z.number().int().min(0),
    guests_created: z.number().int().min(0),
    guests_deleted: z.number().int().min(0),
    logins_refused: z.number().int().min(0),
  })
  .strict();

/** A connected account as the log shows it: the latest scope check, never a key. */
export const TrustConnection = z
  .object({
    connection_id: ConnectionId,
    exchange: Exchange,
    scope: z.string().max(40).describe('the scope the check proved, e.g. "read"'),
    checked_at: Timestamp,
  })
  .strict();

export const TrustCounts = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sandboxes_created: z.number().int().min(0),
    articles_read: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("browse boxes only: sandbox.created rows whose ids.kind is 'browse' (the math step's compute boxes aren't articles)"),
    sandboxes_destroyed: z.number().int().min(0),
    sandboxes_killed: z.number().int().min(0),
    proxy_refused: z.number().int().min(0),
    runs_poisoned: z.number().int().min(0),
    consents: z.array(z.object({ action: z.string(), at: Timestamp, subject_id: z.string().nullable() }).strict()),
    connected: z.array(TrustConnection).default([]).describe('connected accounts and their scope, from connection.scope_checked rows'),
    site: TrustSiteCounts.default({ signups: 0, guests_created: 0, guests_deleted: 0, logins_refused: 0 }).describe(
      "the whole site's sign-ups, guests and refused logins today (UTC), from accounts' rows",
    ),
    head: SignedHead,
  })
  .strict();

export const AUDIT = api('audit', {
  trust: {
    method: 'GET',
    path: '/trust',
    callers: ['edge'],
    query: z.object({ account_id: AccountId }),
    response: TrustCounts,
    summary: "The trust page's counts (spend comes from models).",
  },
  head: {
    method: 'GET',
    path: '/audit/head',
    callers: ['edge'],
    response: SignedHead,
    summary: 'The signed chain head.',
  },
  verify: {
    method: 'GET',
    path: '/audit/verify',
    callers: ['edge'],
    query: z.object({ from: z.coerce.number().int().min(0).optional(), to: z.coerce.number().int().min(0).optional() }),
    response: z
      .object({ ok: z.boolean(), checked: z.number().int().min(0), first_bad_seq: z.number().int().nullable(), head: SignedHead })
      .strict(),
    summary: 'Re-walk the hash chain and check the head signature.',
  },
  row: {
    method: 'GET',
    path: '/audit/rows/:row_id',
    callers: ['edge'],
    params: z.object({ row_id: AuditRowId }),
    query: z.object({ account_id: AccountId }),
    response: AuditRow,
    errors: [404],
    summary: 'One row, for a receipt or a blocked note.',
  },
});
