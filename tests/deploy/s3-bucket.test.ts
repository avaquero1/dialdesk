/**
 * deploy/s3-bucket.ts's lifecycle rule against a small stand-in S3 (no Docker; `make s3-test` runs the real versitygw):
 * the screenshots bucket gets an expiry rule that reads back, a store without lifecycle support gets a MISSING result
 * (the buckets are still made), and a heads bucket with a lifecycle rule is refused.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCREENSHOT_EXPIRE_DAYS, ensureBuckets, lifecycleXml } from '../../deploy/s3-bucket.ts';

const dir = mkdtempSync(join(tmpdir(), 'vha-s3-bucket-test-'));
const cred = join(dir, 's3');
writeFileSync(cred, 'access_key_id=AKIAEXAMPLE1234567\nsecret_access_key=SeCrEtExAmPlEvAlUe0987654321\n', { mode: 0o600 });

/** Buckets by name: whether it was made with lock, and its lifecycle XML. `lifecycle: false` = a store without it. */
const store = { lifecycle: true, buckets: new Map<string, { lock: boolean; rules: string | null }>(), md5ok: true };
const err = (code: string) => `<?xml version="1.0"?><Error><Code>${code}</Code></Error>`;
let server: Server;
let endpoint = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const name = u.pathname.slice(1);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const b = store.buckets.get(name);
      const send = (status: number, text = '') => res.writeHead(status, { 'content-type': 'application/xml' }).end(text);
      if (u.searchParams.has('lifecycle')) {
        if (!store.lifecycle) return send(501, err('NotImplemented'));
        if (!b) return send(404, err('NoSuchBucket'));
        if (req.method === 'PUT') {
          store.md5ok &&= req.headers['content-md5'] === createHash('md5').update(body).digest('base64');
          b.rules = body.toString();
          return send(200);
        }
        return b.rules ? send(200, b.rules) : send(404, err('NoSuchLifecycleConfiguration'));
      }
      if (u.searchParams.has('object-lock')) {
        if (!b?.lock) return send(404, err('ObjectLockConfigurationNotFound'));
        return send(200, '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>');
      }
      if (req.method === 'PUT') {
        if (b) return send(409, err('BucketAlreadyOwnedByYou'));
        store.buckets.set(name, { lock: req.headers['x-amz-bucket-object-lock-enabled'] === 'true', rules: null });
        return send(200);
      }
      send(400, err('Unexpected'));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const a = server.address();
  endpoint = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
const env = (shots: string, heads: string, extra: Record<string, string> = {}) => ({
  S3_ENDPOINT: endpoint,
  S3_BUCKET_SCREENSHOTS: shots,
  S3_BUCKET_HEADS: heads,
  S3_SCREENSHOTS_CREDENTIALS: cred,
  ...extra,
});

describe('deploy/s3-bucket.ts lifecycle', () => {
  it('the screenshots bucket expires every object after 2 days; heads has no rule', async () => {
    store.lifecycle = true;
    const r = await ensureBuckets(env('shots-a', 'heads-a'));
    expect(SCREENSHOT_EXPIRE_DAYS).toBe(2);
    expect(r).toEqual([
      { role: 'screenshots', bucket: 'shots-a', result: 'created', objectLock: null, expiry: 'after 2 days' },
      { role: 'heads', bucket: 'heads-a', result: 'created', objectLock: 'Enabled', expiry: 'none' },
    ]);
    expect(store.buckets.get('shots-a')!.rules).toBe(lifecycleXml(2));
    expect(store.buckets.get('heads-a')!.rules).toBeNull();
    expect(store.md5ok, 'Content-MD5 matches the body').toBe(true);
    // Again: the same rule, nothing else changes. S3_SCREENSHOTS_EXPIRE_DAYS changes the days.
    expect((await ensureBuckets(env('shots-a', 'heads-a'))).map((x) => [x.result, x.expiry])).toEqual([['exists', 'after 2 days'], ['exists', 'none']]);
    expect((await ensureBuckets(env('shots-a', 'heads-a', { S3_SCREENSHOTS_EXPIRE_DAYS: '5' })))[0]!.expiry).toBe('after 5 days');
    await expect(ensureBuckets(env('shots-a', 'heads-a', { S3_SCREENSHOTS_EXPIRE_DAYS: '0' }))).rejects.toThrow(/1 to 365/);
  });

  it('a store without lifecycle rules: the buckets are made and the result says MISSING', async () => {
    store.lifecycle = false;
    const r = await ensureBuckets(env('shots-b', 'heads-b'));
    expect(r.map((x) => x.result)).toEqual(['created', 'created']);
    expect(r[0]!.expiry).toBe('MISSING: the store refused the lifecycle rule (501 NotImplemented)');
    expect(r[1]!.expiry).toBe('none');
  });

  it('refuses a heads bucket that has a lifecycle rule', async () => {
    store.lifecycle = true;
    await ensureBuckets(env('shots-c', 'heads-c'));
    store.buckets.get('heads-c')!.rules = lifecycleXml(30);
    await expect(ensureBuckets(env('shots-c', 'heads-c'))).rejects.toThrow(/heads-c has a lifecycle rule/);
  });
});
