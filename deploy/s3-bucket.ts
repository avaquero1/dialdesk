/**
 * Makes the two Object Storage buckets, once, before the services start (deploy.sh runs it on control in the app image):
 * - screenshots (board): private, plain.
 * - heads (audit): made with object lock, so each signed head can be locked in COMPLIANCE mode (AUDIT_S3_LOCK_DAYS).
 *   Object lock can only be chosen when a bucket is made, so a heads bucket that exists without it is an error.
 * Safe to run again: a bucket that exists (and is ours) is left as it is.
 *
 *   node --import tsx deploy/s3-bucket.ts
 *
 * Env (deploy.env): S3_ENDPOINT, S3_REGION (us-east-1), S3_BUCKET_SCREENSHOTS, S3_BUCKET_HEADS, and the key files
 * S3_SCREENSHOTS_CREDENTIALS and S3_HEADS_CREDENTIALS (the same file twice when one key reaches both). It prints bucket
 * names and what it did, never a key.
 */
import { pathToFileURL } from 'node:url';
import { S3Client, readS3Credentials } from '@app/service-kit';

type Env = Record<string, string | undefined>;
export type BucketResult = { role: 'screenshots' | 'heads'; bucket: string; result: 'created' | 'exists'; objectLock: string | null };

export async function ensureBuckets(env: Env): Promise<BucketResult[]> {
  const missing = ['S3_ENDPOINT', 'S3_BUCKET_SCREENSHOTS', 'S3_BUCKET_HEADS', 'S3_SCREENSHOTS_CREDENTIALS'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`s3-bucket: not set: ${missing.join(', ')}`);
  const client = (bucket: string, credFile: string) =>
    new S3Client({ endpoint: env.S3_ENDPOINT!, region: env.S3_REGION || 'us-east-1', bucket, ...readS3Credentials(credFile) });

  const shots = client(env.S3_BUCKET_SCREENSHOTS!, env.S3_SCREENSHOTS_CREDENTIALS!);
  const heads = client(env.S3_BUCKET_HEADS!, env.S3_HEADS_CREDENTIALS || env.S3_SCREENSHOTS_CREDENTIALS!);
  if (shots.cfg.bucket === heads.cfg.bucket) throw new Error('s3-bucket: the screenshots and heads buckets must differ');

  const out: BucketResult[] = [];
  const r1 = await shots.createBucket();
  out.push({ role: 'screenshots', bucket: shots.cfg.bucket, result: r1, objectLock: await shots.objectLock() });
  const r2 = await heads.createBucket({ objectLock: true });
  const lock = await heads.objectLock();
  if (lock !== 'Enabled') {
    throw new Error(`s3-bucket: ${heads.cfg.bucket} exists without object lock. Make a new heads bucket (lock is chosen at creation).`);
  }
  out.push({ role: 'heads', bucket: heads.cfg.bucket, result: r2, objectLock: lock });
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureBuckets(process.env).then(
    (rs) => {
      for (const r of rs) process.stdout.write(`s3-bucket: ${r.role} ${r.bucket}: ${r.result}, object lock ${r.objectLock ?? 'off'}\n`);
    },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
