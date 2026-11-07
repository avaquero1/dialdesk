import { z } from 'zod';
import { AccountId, AuditRowId, Timestamp } from '../common.ts';
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

export const TrustCounts = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sandboxes_created: z.number().int().min(0),
    sandboxes_destroyed: z.number().int().min(0),
    sandboxes_killed: z.number().int().min(0),
    proxy_refused: z.number().int().min(0),
    runs_poisoned: z.number().int().min(0),
    consents: z.array(z.object({ action: z.string(), at: Timestamp, subject_id: z.string().nullable() }).strict()),
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
