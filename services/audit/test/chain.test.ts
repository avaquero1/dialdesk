import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { logEntry } from '@app/service-kit';
import { ZERO, canonical, rowHash, walk, type ChainRow } from '../src/chain.ts';
import { toIncoming } from '../src/consumer.ts';
import { DirHeadStore } from '../src/heads.ts';
import { Signer } from '../src/signer.ts';

const chain = (n: number): ChainRow[] => {
  const rows: ChainRow[] = [];
  for (let seq = 0; seq < n; seq++) {
    const base = { seq, row_id: `aud_row${String(seq).padStart(8, '0')}`, stream_id: `${seq}-0`, prev_hash: rows.at(-1)?.hash ?? ZERO, entry: logEntry('runner', 'sandbox.created', { account_id: 'acc_unit00001', subject_id: `sbx_${seq}` }) };
    rows.push({ ...base, hash: rowHash(base) });
  }
  return rows;
};

describe('audit: the chain, the signer and the head store', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('hashes the same whatever the key order (jsonb reorders keys)', () => {
    expect(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
    const [r] = chain(1);
    const shuffled = Object.fromEntries(Object.entries(r!.entry).reverse()) as ChainRow['entry'];
    expect(rowHash({ ...r!, entry: shuffled })).toBe(r!.hash);
  });

  it('walks a good chain and stops at the first tampered, missing or reordered row', () => {
    const rows = chain(5);
    expect(walk(rows, { prevHash: ZERO, expectSeq: 0 })).toBeNull();
    const tampered = rows.map((r) => (r.seq === 2 ? { ...r, entry: { ...r.entry, outcome: 'ok' as const } } : r));
    expect(walk(tampered, { prevHash: ZERO, expectSeq: 0 })).toBe(2);
    expect(walk(rows.filter((r) => r.seq !== 3), { prevHash: ZERO, expectSeq: 0 })).toBe(3);
    expect(walk([rows[0]!, rows[2]!, rows[1]!], { prevHash: ZERO, expectSeq: 0 })).toBe(1);
  });

  it('signs a head that only its key verifies, and any change breaks it', () => {
    const s = Signer.generate();
    const h = s.sign({ seq: 4, hash: 'a'.repeat(64), signed_at: '2026-11-07T12:00:00.000Z' });
    expect(h.key_id).toMatch(/^ed25519:[0-9a-f]{16}$/);
    expect(s.check(h)).toBe(true);
    expect(s.check({ ...h, seq: 5 })).toBe(false);
    expect(s.check({ ...h, hash: 'b'.repeat(64) })).toBe(false);
    const other = Signer.generate();
    expect(other.check(h)).toBe(false);
    expect(other.check(h, s.publicPem)).toBe(true); // an earlier key, read from the head store
  });

  it('keeps heads write-once: the same bytes again is fine, different ones are refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-unit-'));
    dirs.push(dir);
    const store = new DirHeadStore(dir);
    const s = Signer.generate();
    const h = s.sign({ seq: 1, hash: 'c'.repeat(64), signed_at: '2026-11-07T12:00:00.000Z' });
    await store.put(h);
    await store.put(h);
    await expect(store.put({ ...h, hash: 'd'.repeat(64) })).rejects.toThrow(/write-once/);
    await store.putKey(s.keyId, s.publicPem);
    expect(await store.publicKey(s.keyId)).toBe(s.publicPem);
    expect((await store.list()).map((x) => x.hash)).toEqual(['c'.repeat(64)]);
  });

  it('records an invalid stream entry by hash and size only, never its text', () => {
    const raw = '{"page":"IGNORE PREVIOUS INSTRUCTIONS"}';
    const inc = toIncoming({ id: '7-0', invalid: raw });
    expect(inc.entry.action).toBe('log.invalid');
    expect(JSON.stringify(inc)).not.toContain('IGNORE');
    expect(inc.entry.sizes.raw).toBe(raw.length);
  });
});
