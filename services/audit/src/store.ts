import postgres from 'postgres';
import { ConnectionId, Exchange, LogEntry, SignedHead, TRUST_ACTIONS as A, newId, type TrustConnection } from '@app/contracts';
import type { z } from 'zod';
import { ZERO, rowHash, type ChainRow } from './chain.ts';

type Head = z.infer<typeof SignedHead>;
export type Incoming = { stream_id: string | null; entry: LogEntry };

type DbRow = { seq: string; row_id: string; stream_id: string | null; prev_hash: string; hash: string; entry: unknown };
const toRow = (r: DbRow): ChainRow => ({
  seq: Number(r.seq),
  row_id: r.row_id,
  stream_id: r.stream_id,
  prev_hash: r.prev_hash,
  hash: r.hash,
  // Parsed for the type only: a row tampered into another shape still hashes (and fails) as stored.
  entry: r.entry as LogEntry,
});

/** One lock for every appender, so two audit processes can never fork the chain. */
const CHAIN_LOCK = 0x61756469; // "audi"

/** The audit schema, as role svc_audit: INSERT and SELECT only (see migrations/0002_chain.sql). */
export class PgAuditStore {
  readonly sql: postgres.Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 3, onnotice: () => {} });
  }

  /**
   * Appends entries in order, in one transaction. Entries whose stream id is already in the chain are skipped (an
   * entry read again after a crash before its ack), so re-delivery never writes a row twice.
   */
  async append(items: Incoming[]): Promise<ChainRow[]> {
    if (!items.length) return [];
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${CHAIN_LOCK})`;
      const ids = items.map((i) => i.stream_id).filter((x): x is string => x !== null);
      const seen = new Set(
        ids.length ? (await tx<{ stream_id: string }[]>`select stream_id from chain where stream_id = any(${ids})`).map((r) => r.stream_id) : [],
      );
      const [last] = await tx<{ seq: string; hash: string }[]>`select seq, hash from chain order by seq desc limit 1`;
      let seq = last ? Number(last.seq) + 1 : 0;
      let prev = last?.hash ?? ZERO;
      const out: ChainRow[] = [];
      for (const it of items) {
        if (it.stream_id && seen.has(it.stream_id)) continue;
        if (it.stream_id) seen.add(it.stream_id);
        const base = { seq, row_id: newId('aud'), stream_id: it.stream_id, prev_hash: prev, entry: it.entry };
        const row: ChainRow = { ...base, hash: rowHash(base) };
        await tx`insert into chain (seq, row_id, stream_id, prev_hash, hash, entry)
          values (${row.seq}, ${row.row_id}, ${row.stream_id}, ${row.prev_hash}, ${row.hash}, ${tx.json(row.entry as never)})`;
        out.push(row);
        prev = row.hash;
        seq++;
      }
      return out;
    });
  }

  async last(): Promise<ChainRow | null> {
    const [r] = await this.sql<DbRow[]>`select * from chain order by seq desc limit 1`;
    return r ? toRow(r) : null;
  }

  async byId(rowId: string): Promise<ChainRow | null> {
    const [r] = await this.sql<DbRow[]>`select * from chain where row_id = ${rowId}`;
    return r ? toRow(r) : null;
  }

  async at(seqs: number[]): Promise<Map<number, ChainRow>> {
    if (!seqs.length) return new Map();
    const rows = await this.sql<DbRow[]>`select * from chain where seq = any(${seqs})`;
    return new Map(rows.map((r) => [Number(r.seq), toRow(r)]));
  }

  /** Rows from..to (inclusive) in order, a page at a time. */
  async *range(from: number, to: number, page = 1000): AsyncGenerator<ChainRow[]> {
    for (let start = from; start <= to; start += page) {
      const end = Math.min(to, start + page - 1);
      const rows = await this.sql<DbRow[]>`select * from chain where seq between ${start} and ${end} order by seq`;
      yield rows.map(toRow);
      if (rows.length === 0) return;
    }
  }

  async saveHead(h: Head) {
    await this.sql`insert into heads (seq, hash, signed_at, signed_at_text, key_id, signature)
      values (${h.seq}, ${h.hash}, ${h.signed_at}, ${h.signed_at}, ${h.key_id}, ${h.signature}) on conflict (seq) do nothing`;
  }

  private headSelect() {
    return this.sql<{ seq: string; hash: string; signed_at_text: string; key_id: string; signature: string; pushed_at: Date | null }[]>`
      select h.seq, h.hash, h.signed_at_text, h.key_id, h.signature, p.pushed_at
      from heads h left join head_pushes p on p.seq = h.seq order by h.seq desc limit 1`;
  }

  private static toHead(r: { seq: string; hash: string; signed_at_text: string; key_id: string; signature: string; pushed_at: Date | null }): Head {
    return {
      seq: Number(r.seq),
      hash: r.hash,
      signed_at: r.signed_at_text,
      alg: 'Ed25519',
      key_id: r.key_id,
      signature: r.signature,
      pushed_at: r.pushed_at?.toISOString() ?? null,
    };
  }

  /** The newest signed head, with when it reached write-once storage (null = not pushed yet). */
  async latestHead(): Promise<Head | null> {
    const [r] = await this.headSelect();
    return r ? PgAuditStore.toHead(r) : null;
  }

  /** The newest head, if it hasn't been pushed. */
  async unpushedHead(): Promise<Head | null> {
    const h = await this.latestHead();
    return h && !h.pushed_at ? h : null;
  }

  async recordPush(seq: number, objectKey: string, store: string) {
    await this.sql`insert into head_pushes (seq, object_key, store) values (${seq}, ${objectKey}, ${store}) on conflict (seq) do nothing`;
  }

  /** The trust page's numbers for one account: today's counts (UTC), all its consents and its connected accounts. */
  async trust(accountId: string, day: string) {
    const counted = [A.sandboxCreated, A.sandboxDestroyed, A.sandboxKilled, A.proxyRefused, A.runPoisoned];
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
    const rows = await this.sql<{ action: string; n: number; requests: number }[]>`
      select entry->>'action' as action, count(*)::int as n,
             sum(case when jsonb_typeof(entry->'sizes'->'requests') = 'number' then (entry->'sizes'->>'requests')::bigint else 1 end)::int as requests
      from chain
      where entry->>'account_id' = ${accountId} and entry->>'action' = any(${counted})
        and (entry->>'at')::timestamptz >= ${`${day}T00:00:00Z`} and (entry->>'at')::timestamptz < ${next}
      group by 1`;
    const n = (a: string) => rows.find((r) => r.action === a)?.n ?? 0;
    // The site's account rows: every account, counts only.
    const siteActions = [A.accountCreated, A.guestCreated, A.accountDeleted, A.loginRefused];
    const siteRows = await this.sql<{ action: string; n: number }[]>`
      select entry->>'action' as action, count(*)::int as n
      from chain
      where entry->>'action' = any(${siteActions})
        and (entry->>'at')::timestamptz >= ${`${day}T00:00:00Z`} and (entry->>'at')::timestamptz < ${next}
      group by 1`;
    const s = (a: string) => siteRows.find((r) => r.action === a)?.n ?? 0;
    const consents = await this.sql<{ action: string; at: string; subject_id: string | null }[]>`
      select entry->>'action' as action, entry->>'at' as at, entry->>'subject_id' as subject_id
      from chain where entry->>'account_id' = ${accountId} and starts_with(entry->>'action', ${A.consentPrefix}) order by seq`;
    const conn = await this.sql<{ entry: LogEntry }[]>`
      select entry from chain
      where entry->>'account_id' = ${accountId} and entry->>'action' in (${A.connectionChecked}, ${A.connectionRemoved}) order by seq`;
    const by = new Map<string, z.infer<typeof TrustConnection> | null>();
    for (const { entry: e } of conn) {
      if (!e.subject_id) continue;
      const exchange = Exchange.safeParse(e.ids?.exchange);
      const live = e.action === A.connectionChecked && e.outcome === 'ok' && exchange.success && ConnectionId.safeParse(e.subject_id).success;
      by.set(e.subject_id, live ? { connection_id: e.subject_id, exchange: exchange.data!, scope: (e.ids.scope ?? 'read').slice(0, 40), checked_at: e.at } : null);
    }
    return {
      day,
      sandboxes_created: n(A.sandboxCreated),
      sandboxes_destroyed: n(A.sandboxDestroyed),
      sandboxes_killed: n(A.sandboxKilled),
      proxy_refused: rows.find((r) => r.action === A.proxyRefused)?.requests ?? 0,
      runs_poisoned: n(A.runPoisoned),
      consents: consents.map((c) => ({ action: c.action, at: c.at, subject_id: c.subject_id })),
      connected: [...by.values()].filter((c) => c !== null),
      site: { signups: s(A.accountCreated), guests_created: s(A.guestCreated), guests_deleted: s(A.accountDeleted), logins_refused: s(A.loginRefused) },
    };
  }

  async end() {
    await this.sql.end();
  }
}
