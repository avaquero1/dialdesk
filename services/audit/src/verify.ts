import type { SignedHead } from '@app/contracts';
import type { z } from 'zod';
import { ZERO, walk } from './chain.ts';
import type { HeadStore, StoredHead } from './heads.ts';
import type { Signer } from './signer.ts';
import type { PgAuditStore } from './store.ts';

type Head = z.infer<typeof SignedHead>;
export type VerifyResult = { ok: boolean; checked: number; first_bad_seq: number | null; head: Head };

/**
 * Re-walks the chain from..to, then checks the heads against it: the newest signed head in the database and every
 * head in write-once storage. A row rewritten with every later hash recomputed passes the walk, but no longer matches
 * the head that was pushed before the rewrite; rows deleted from the end leave a pushed head with no row.
 * `first_bad_seq` is the lowest seq where anything fails.
 */
export async function verifyChain(
  deps: { store: PgAuditStore; signer: Signer; heads: HeadStore },
  q: { from?: number; to?: number },
): Promise<VerifyResult> {
  const { store, signer, heads } = deps;
  const head = await store.latestHead();
  const last = await store.last();
  if (!head || !last) throw new Error('audit: the chain has no head yet');
  const from = q.from ?? 0;
  const to = Math.min(q.to ?? Math.max(last.seq, head.seq), Math.max(last.seq, head.seq));
  const bad: number[] = [];

  // 1. The rows.
  let checked = 0;
  const state = { prevHash: ZERO, expectSeq: from };
  if (from > 0) {
    const before = (await store.at([from - 1])).get(from - 1);
    if (!before) bad.push(from - 1);
    else state.prevHash = before.hash;
  }
  if (!bad.length) {
    for await (const page of store.range(from, to)) {
      const start = state.expectSeq;
      const b = walk(page, state);
      checked += (b ?? state.expectSeq) - start;
      if (b !== null) {
        bad.push(b);
        break;
      }
    }
    if (!bad.length && state.expectSeq <= to) bad.push(state.expectSeq); // rows missing at the end
  }

  // 2. The heads: the database's newest, and every pushed one in range (all of them for a full check).
  const pushed = (await heads.list()).filter((h) => h.seq >= from && (q.to === undefined || h.seq <= to));
  const toCheck: StoredHead[] = [head, ...pushed];
  const rows = await store.at([...new Set(toCheck.map((h) => h.seq))]);
  const keys = new Map<string, string | null>();
  for (const h of toCheck) {
    let pem: string | undefined;
    if (h.key_id !== signer.keyId) {
      if (!keys.has(h.key_id)) keys.set(h.key_id, await heads.publicKey(h.key_id));
      pem = keys.get(h.key_id) ?? undefined;
    }
    const sigOk = (h.key_id === signer.keyId || pem !== undefined) && signer.check({ ...h, pushed_at: null }, pem);
    if (!sigOk || rows.get(h.seq)?.hash !== h.hash) bad.push(h.seq);
  }

  const first = bad.length ? Math.min(...bad) : null;
  return { ok: first === null, checked, first_bad_seq: first, head };
}
