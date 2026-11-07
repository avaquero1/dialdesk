import { createHash } from 'node:crypto';
import type { LogEntry } from '@app/contracts';

/** The hash before the first row. */
export const ZERO = '0'.repeat(64);

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/**
 * JSON with object keys sorted at every level, so a row hashes the same however it was stored (Postgres jsonb
 * reorders keys). Only what a LogEntry can hold: objects, arrays, strings, integers, booleans and null.
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

export type ChainRow = {
  seq: number;
  row_id: string;
  /** The `log:actions` entry this row came from (null for audit's own first row). */
  stream_id: string | null;
  prev_hash: string;
  hash: string;
  entry: LogEntry;
};

/**
 * hash = sha256(prev_hash + "\n" + canonical({ seq, row_id, stream_id, entry })). The seq and row id are inside the
 * hash, so rows can't be reordered or renumbered without breaking the chain.
 */
export function rowHash(r: Omit<ChainRow, 'hash'>): string {
  return sha256(`${r.prev_hash}\n${canonical({ seq: r.seq, row_id: r.row_id, stream_id: r.stream_id, entry: r.entry })}`);
}

/** The bytes a head's signature covers. */
export function headMessage(h: { seq: number; hash: string; signed_at: string; key_id: string }): Buffer {
  return Buffer.from(canonical({ v: 'audit-head-v1', seq: h.seq, hash: h.hash, signed_at: h.signed_at, key_id: h.key_id }));
}

/**
 * Re-walks rows in order from `expectSeq`, starting after `prevHash`. Returns the first seq that is missing, out of
 * order, or whose links or hash don't match; null when every row checks out.
 */
export function walk(rows: Iterable<ChainRow>, state: { prevHash: string; expectSeq: number }): number | null {
  for (const r of rows) {
    if (r.seq !== state.expectSeq || r.prev_hash !== state.prevHash || rowHash(r) !== r.hash) return state.expectSeq;
    state.prevHash = r.hash;
    state.expectSeq++;
  }
  return null;
}
