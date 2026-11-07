import { createHash } from 'node:crypto';
import { AUDIT, Exchange, LogEntry, TRUST_ACTIONS as A, newId, type SignedHead, type TrustConnection } from '@app/contracts';
import type { z } from 'zod';
import { HttpError, now, type Handlers } from '@app/service-kit';

export type FakeDeps = Record<string, never>;
export async function fakeDepsFromEnv(): Promise<FakeDeps> {
  return {};
}

type Row = { row_id: string; seq: number; prev_hash: string; hash: string; entry: LogEntry };
const ZERO = '0'.repeat(64);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * An in-memory hash chain. `append` stands in for the log-stream consumer. The head's signature is a fake
 * (base64 of "fake-signature"); the real audit (src/real.ts) chains rows in Postgres, signs heads with Ed25519 and
 * pushes them to write-once storage.
 */
export function createFakeAudit() {
  const rows: Row[] = [];
  const append = (entry: LogEntry) => {
    const e = LogEntry.parse(entry);
    const prev_hash = rows.at(-1)?.hash ?? ZERO;
    const row: Row = { row_id: newId('aud'), seq: rows.length, prev_hash, hash: sha(prev_hash + JSON.stringify(e)), entry: e };
    rows.push(row);
    return row;
  };
  const head = (): z.infer<typeof SignedHead> => ({
    seq: Math.max(0, rows.length - 1),
    hash: rows.at(-1)?.hash ?? ZERO,
    signed_at: now(),
    alg: 'Ed25519',
    key_id: 'fake-key',
    signature: Buffer.from('fake-signature').toString('base64'),
    pushed_at: null,
  });
  const today = (account_id: string) => {
    const day = now().slice(0, 10);
    return rows.filter((r) => r.entry.account_id === account_id && r.entry.at.slice(0, 10) === day);
  };
  const site = () => {
    const day = now().slice(0, 10);
    const n = (action: string) => rows.filter((r) => r.entry.action === action && r.entry.at.slice(0, 10) === day).length;
    return { signups: n(A.accountCreated), guests_created: n(A.guestCreated), guests_deleted: n(A.accountDeleted), logins_refused: n(A.loginRefused) };
  };
  const count = (action: string, account_id: string) => today(account_id).filter((r) => r.entry.action === action).length;
  const refused = (account_id: string) =>
    today(account_id)
      .filter((r) => r.entry.action === A.proxyRefused)
      .reduce((n, r) => n + (r.entry.sizes.requests ?? 1), 0);
  const connected = (account_id: string) => {
    const by = new Map<string, z.infer<typeof TrustConnection> | null>();
    for (const r of rows) {
      const e = r.entry;
      if (e.account_id !== account_id || !e.subject_id) continue;
      if (e.action === A.connectionRemoved) by.set(e.subject_id, null);
      if (e.action !== A.connectionChecked) continue;
      const exchange = Exchange.safeParse(e.ids.exchange);
      by.set(e.subject_id, e.outcome === 'ok' && exchange.success ? { connection_id: e.subject_id, exchange: exchange.data, scope: e.ids.scope ?? 'read', checked_at: e.at } : null);
    }
    return [...by.values()].filter((c) => c !== null);
  };

  const handlers: Handlers<typeof AUDIT> = {
    trust: ({ query }) => ({
      day: now().slice(0, 10),
      sandboxes_created: count(A.sandboxCreated, query.account_id),
      sandboxes_destroyed: count(A.sandboxDestroyed, query.account_id),
      sandboxes_killed: count(A.sandboxKilled, query.account_id),
      proxy_refused: refused(query.account_id),
      runs_poisoned: count(A.runPoisoned, query.account_id),
      consents: rows
        .filter((r) => r.entry.account_id === query.account_id && r.entry.action.startsWith(A.consentPrefix))
        .map((r) => ({ action: r.entry.action, at: r.entry.at, subject_id: r.entry.subject_id })),
      connected: connected(query.account_id),
      site: site(),
      head: head(),
    }),
    head: () => head(),
    verify: ({ query }) => {
      const from = query.from ?? 0;
      const to = Math.min(query.to ?? rows.length - 1, rows.length - 1);
      let bad: number | null = null;
      for (let i = from; i <= to; i++) {
        const r = rows[i]!;
        const prev = i === 0 ? ZERO : rows[i - 1]!.hash;
        if (r.prev_hash !== prev || r.hash !== sha(prev + JSON.stringify(r.entry))) {
          bad = i;
          break;
        }
      }
      return { ok: bad === null, checked: Math.max(0, to - from + 1), first_bad_seq: bad, head: head() };
    },
    row: ({ params, query }) => {
      const r = rows.find((x) => x.row_id === params.row_id);
      if (!r || r.entry.account_id !== query.account_id) throw new HttpError(404, 'not_found', 'no such row');
      return r;
    },
  };
  return { handlers, append, rows };
}

export function fake(_deps: FakeDeps = {}): Handlers<typeof AUDIT> {
  return createFakeAudit().handlers;
}
