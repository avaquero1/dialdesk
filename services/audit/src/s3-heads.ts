/**
 * Signed heads in Vultr Object Storage (S3 API), write-once, behind audit's HeadStore. Chosen when AUDIT_S3_BUCKET is
 * set; otherwise audit keeps the write-once folder (DirHeadStore).
 *
 * Write-once, two ways:
 * - Every PUT carries If-None-Match: * , so the server refuses to replace a key that exists (412). Before the PUT the
 *   key is read: the same bytes again is fine (a push that crashed before it was recorded), other bytes is an error.
 * - With AUDIT_S3_LOCK_DAYS > 0 (a bucket made with object lock), each head is also locked in COMPLIANCE mode, so not
 *   even the bucket's owner can delete or overwrite it until then.
 * Heads never change once written, so each one is fetched once and kept in memory (verify reads the list often).
 */
import { SignedHead } from '@app/contracts';
import { S3Client, S3Error, s3FromConfig } from '@app/service-kit';
import { headKey, type HeadStore, type StoredHead } from './heads.ts';

const keyKey = (keyId: string) => `keys/${keyId.replace(/[^a-z0-9]/gi, '_')}.pem`;
const HEAD_KEY = /^heads\/\d{12}\.json$/;

export class S3HeadStore implements HeadStore {
  readonly kind = 's3';
  private readonly seen = new Map<string, StoredHead>();
  constructor(
    private readonly s3: S3Client,
    private readonly lockDays = 0,
  ) {}

  private async writeOnce(key: string, body: string, contentType: string) {
    const bytes = Buffer.from(body);
    const existing = await this.s3.get(key);
    if (existing) {
      if (existing.equals(bytes)) return;
      throw new Error(`audit: ${key} exists with other content (write-once)`);
    }
    const lockUntil = this.lockDays > 0 ? new Date(Date.now() + this.lockDays * 86_400_000) : undefined;
    try {
      await this.s3.put(key, bytes, { contentType, ifNoneMatch: true, lockUntil });
    } catch (e) {
      // Lost a race with another writer: fine only if it wrote the same bytes.
      if (e instanceof S3Error && (e.status === 412 || e.status === 409)) {
        const now = await this.s3.get(key);
        if (now?.equals(bytes)) return;
        throw new Error(`audit: ${key} exists with other content (write-once)`, { cause: e });
      }
      throw e;
    }
  }

  async put(head: StoredHead) {
    const key = headKey(head.seq);
    const { seq, hash, signed_at, alg, key_id, signature } = head;
    await this.writeOnce(key, JSON.stringify({ seq, hash, signed_at, alg, key_id, signature }) + '\n', 'application/json');
    return { key };
  }

  async putKey(keyId: string, publicPem: string) {
    await this.writeOnce(keyKey(keyId), publicPem, 'application/x-pem-file');
  }

  async list(): Promise<StoredHead[]> {
    const keys = (await this.s3.list('heads/')).filter((k) => HEAD_KEY.test(k)).sort();
    const out: StoredHead[] = [];
    for (const k of keys) {
      let h = this.seen.get(k);
      if (!h) {
        const body = await this.s3.get(k);
        if (!body) continue;
        h = SignedHead.omit({ pushed_at: true }).parse(JSON.parse(body.toString('utf8')));
        this.seen.set(k, h);
      }
      out.push(h);
    }
    return out;
  }

  async publicKey(keyId: string) {
    const body = await this.s3.get(keyKey(keyId));
    return body ? body.toString('utf8') : null;
  }
}

/** S3 when AUDIT_S3_BUCKET (+ _ENDPOINT, _REGION, _CREDENTIALS_FILE, _LOCK_DAYS) is set, else null. */
export function s3HeadStoreFromConfig(cfg: Record<string, unknown>): S3HeadStore | null {
  const s3 = s3FromConfig(cfg);
  return s3 ? new S3HeadStore(s3, Number(cfg.S3_LOCK_DAYS ?? 0) || 0) : null;
}
