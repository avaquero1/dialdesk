/**
 * Makes the two Object Storage buckets, once, before the services start (deploy.sh runs it on control in the app image):
 * - screenshots (board): private, plain, with a lifecycle rule that expires every object after
 *   S3_SCREENSHOTS_EXPIRE_DAYS (default 2), so a swept guest's screenshots don't outlive it. If the store refuses
 *   lifecycle rules, it says so on a WARNING line (the buckets are still made) and nothing expires them.
 * - heads (audit): made with object lock, so each signed head can be locked in COMPLIANCE mode (AUDIT_S3_LOCK_DAYS).
 *   Object lock can only be chosen when a bucket is made, so a heads bucket that exists without it is an error.
 *   It must never expire: a heads bucket with a lifecycle rule is an error too.
 * Safe to run again: a bucket that exists (and is ours) is left as it is.
 *
 *   node --import tsx deploy/s3-bucket.ts
 *
 * Env (deploy.env): S3_ENDPOINT, S3_REGION (us-east-1), S3_BUCKET_SCREENSHOTS, S3_BUCKET_HEADS, and the key files
 * S3_SCREENSHOTS_CREDENTIALS and S3_HEADS_CREDENTIALS (the same file twice when one key reaches both). It prints bucket
 * names and what it did, never a key.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { S3Client, readS3Credentials } from '@app/service-kit';

type Env = Record<string, string | undefined>;
/** expiry: 'after N days' when the rule is set and reads back, 'none' for heads, or 'MISSING: <why>'. */
export type BucketResult = { role: 'screenshots' | 'heads'; bucket: string; result: 'created' | 'exists'; objectLock: string | null; expiry: string };

export const SCREENSHOT_EXPIRE_DAYS = 2;
const RULE_ID = 'vha-screenshots-expire';
const code = (xml: string) => /<Code>([^<]*)<\/Code>/.exec(xml)?.[1];

export function lifecycleXml(days: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>${RULE_ID}</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><Expiration><Days>${days}</Days></Expiration></Rule></LifecycleConfiguration>`;
}

/** The bucket's lifecycle rules as text, or null when it has none (or the store has no lifecycle support: `unsupported`). */
async function readLifecycle(c: S3Client): Promise<{ xml: string | null; unsupported?: string }> {
  const res = await c.request('GET', undefined, { query: { lifecycle: '' } });
  const text = await res.text().catch(() => '');
  if (res.ok) return { xml: text };
  const why = code(text) ?? `http_${res.status}`;
  if (why === 'NoSuchLifecycleConfiguration') return { xml: null };
  return { xml: null, unsupported: `${res.status} ${why}` };
}

/** Sets the expiry rule and reads it back. Never throws for a store without lifecycle support: it says MISSING instead. */
async function setExpiry(c: S3Client, days: number): Promise<string> {
  const body = Buffer.from(lifecycleXml(days));
  const res = await c.request('PUT', undefined, {
    query: { lifecycle: '' },
    headers: { 'content-type': 'application/xml', 'content-md5': createHash('md5').update(body).digest('base64') },
    body,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) return `MISSING: the store refused the lifecycle rule (${res.status} ${code(text) ?? 'no error code'})`;
  const back = await readLifecycle(c);
  if (back.xml && back.xml.includes(RULE_ID) && new RegExp(`<Days>\\s*${days}\\s*</Days>`).test(back.xml)) return `after ${days} days`;
  return `MISSING: the store took the lifecycle rule but doesn't return it (${back.unsupported ?? 'no such rule'})`;
}

export async function ensureBuckets(env: Env): Promise<BucketResult[]> {
  const days = Number(env.S3_SCREENSHOTS_EXPIRE_DAYS || SCREENSHOT_EXPIRE_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('s3-bucket: S3_SCREENSHOTS_EXPIRE_DAYS must be a whole number of days, 1 to 365');
  const missing = ['S3_ENDPOINT', 'S3_BUCKET_SCREENSHOTS', 'S3_BUCKET_HEADS', 'S3_SCREENSHOTS_CREDENTIALS'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`s3-bucket: not set: ${missing.join(', ')}`);
  const client = (bucket: string, credFile: string) =>
    new S3Client({ endpoint: env.S3_ENDPOINT!, region: env.S3_REGION || 'us-east-1', bucket, ...readS3Credentials(credFile) });

  const shots = client(env.S3_BUCKET_SCREENSHOTS!, env.S3_SCREENSHOTS_CREDENTIALS!);
  const heads = client(env.S3_BUCKET_HEADS!, env.S3_HEADS_CREDENTIALS || env.S3_SCREENSHOTS_CREDENTIALS!);
  if (shots.cfg.bucket === heads.cfg.bucket) throw new Error('s3-bucket: the screenshots and heads buckets must differ');

  const out: BucketResult[] = [];
  const r1 = await shots.createBucket();
  out.push({ role: 'screenshots', bucket: shots.cfg.bucket, result: r1, objectLock: await shots.objectLock(), expiry: await setExpiry(shots, days) });
  const r2 = await heads.createBucket({ objectLock: true });
  const lock = await heads.objectLock();
  if (lock !== 'Enabled') {
    throw new Error(`s3-bucket: ${heads.cfg.bucket} exists without object lock. Make a new heads bucket (lock is chosen at creation).`);
  }
  const hl = await readLifecycle(heads);
  if (hl.xml && /<Rule>/.test(hl.xml)) {
    throw new Error(`s3-bucket: ${heads.cfg.bucket} has a lifecycle rule. Remove it: audit heads must never expire.`);
  }
  out.push({ role: 'heads', bucket: heads.cfg.bucket, result: r2, objectLock: lock, expiry: 'none' });
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureBuckets(process.env).then(
    (rs) => {
      for (const r of rs) {
        process.stdout.write(`s3-bucket: ${r.role} ${r.bucket}: ${r.result}, object lock ${r.objectLock ?? 'off'}, expiry ${r.expiry}\n`);
        if (r.expiry.startsWith('MISSING')) {
          process.stdout.write(`s3-bucket: WARNING: ${r.bucket} has no expiry rule, so screenshots of swept guests stay until deleted by hand. ${r.expiry}\n`);
        }
      }
    },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
