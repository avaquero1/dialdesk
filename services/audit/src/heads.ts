import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SignedHead } from '@app/contracts';
import type { z } from 'zod';

type Head = z.infer<typeof SignedHead>;
export type StoredHead = Omit<Head, 'pushed_at'>;

/**
 * Where signed heads go, off the database: write-once. Production is a Vultr Object Storage bucket with object lock
 * (Phase 3); dev and the fallback are a local folder. A head is never overwritten: putting a different head under a
 * key that exists is an error. Putting the same bytes again is fine (a push that crashed before it was recorded).
 */
export interface HeadStore {
  readonly kind: string;
  put(head: StoredHead): Promise<{ key: string }>;
  putKey(keyId: string, publicPem: string): Promise<void>;
  list(): Promise<StoredHead[]>;
  publicKey(keyId: string): Promise<string | null>;
}

export const headKey = (seq: number) => `heads/${String(seq).padStart(12, '0')}.json`;
const keyKey = (keyId: string) => `keys/${keyId.replace(/[^a-z0-9]/gi, '_')}.pem`;

/** A local folder: files are created with O_EXCL and made read-only. */
export class DirHeadStore implements HeadStore {
  readonly kind = 'dir';
  constructor(private readonly dir: string) {
    mkdirSync(join(dir, 'heads'), { recursive: true });
    mkdirSync(join(dir, 'keys'), { recursive: true });
  }

  private writeOnce(key: string, body: string) {
    const path = join(this.dir, key);
    if (existsSync(path)) {
      if (readFileSync(path, 'utf8') === body) return;
      throw new Error(`audit: ${key} exists with other content (write-once)`);
    }
    writeFileSync(path, body, { flag: 'wx', mode: 0o444 });
    chmodSync(path, 0o444);
  }

  async put(head: StoredHead) {
    const key = headKey(head.seq);
    const { seq, hash, signed_at, alg, key_id, signature } = head;
    this.writeOnce(key, JSON.stringify({ seq, hash, signed_at, alg, key_id, signature }) + '\n');
    return { key };
  }

  async putKey(keyId: string, publicPem: string) {
    this.writeOnce(keyKey(keyId), publicPem);
  }

  async list(): Promise<StoredHead[]> {
    const dir = join(this.dir, 'heads');
    return readdirSync(dir)
      .filter((f) => /^\d{12}\.json$/.test(f))
      .sort()
      .map((f) => SignedHead.omit({ pushed_at: true }).parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
  }

  async publicKey(keyId: string) {
    const path = join(this.dir, keyKey(keyId));
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }
}
