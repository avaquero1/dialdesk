/**
 * The S3 client and the two S3 adapters (board's screenshots, audit's write-once heads) on a real S3 server: versitygw
 * in its own Compose project (deploy/compose.s3-test.yml). Run with `make s3-test`: it starts the project with fresh
 * credentials, runs this file and removes the project. Without S3_TEST=1 (as in `make check`) the file is skipped.
 *
 * What it proves: SigV4 signing (a wrong secret is refused), put/get/list with paging-safe keys, write-once (the same
 * bytes again is fine, other bytes are refused, If-None-Match answers 412), and a bucket made with object lock, whose
 * COMPLIANCE-locked object version can't be deleted.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Client, S3Error, s3FromConfig } from '../../packages/service-kit/src/s3.ts';
import { S3HeadStore } from '../../services/audit/src/s3-heads.ts';
import { S3ObjectStore } from '../../services/board/src/s3-store.ts';
import { ensureBuckets } from '../../deploy/s3-bucket.ts';

const on = process.env.S3_TEST === '1';
const endpoint = `http://127.0.0.1:${process.env.S3_TEST_PORT ?? '57070'}`;
const accessKeyId = process.env.S3_TEST_ACCESS ?? '';
const secretAccessKey = process.env.S3_TEST_SECRET ?? '';
const run = randomBytes(4).toString('hex');
const client = (bucket: string, secret = secretAccessKey) =>
  new S3Client({ endpoint, region: 'us-east-1', bucket, accessKeyId, secretAccessKey: secret, timeoutMs: 5_000 });

const head = (seq: number, hash = 'a'.repeat(64)) => ({
  seq,
  hash,
  signed_at: '2026-11-07T20:00:00.000Z',
  alg: 'Ed25519' as const,
  key_id: 'k1',
  signature: Buffer.from(`sig-${seq}-${hash.slice(0, 4)}`).toString('base64'),
});

describe.skipIf(!on)('S3 on versitygw', () => {
  const plain = client(`vha-test-plain-${run}`);
  const locked = client(`vha-test-locked-${run}`);
  let dir = '';

  beforeAll(async () => {
    // The server has no healthcheck: wait until it answers at all.
    const end = Date.now() + 30_000;
    for (;;) {
      try {
        await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
        break;
      } catch (e) {
        if (Date.now() > end) throw e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    dir = mkdtempSync(join(tmpdir(), 'vha-s3-test-'));
  }, 40_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('creates a bucket once, then reports it exists', async () => {
    expect(await plain.createBucket()).toBe('created');
    expect(await plain.createBucket()).toBe('exists');
  });

  it('refuses a request signed with the wrong secret', async () => {
    const bad = client(plain.cfg.bucket, 'x'.repeat(40));
    const err = await bad.get('nothing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3Error);
    expect((err as S3Error).status).toBe(403);
    expect((err as S3Error).message).not.toContain(secretAccessKey);
  });

  it('puts, gets and lists, keys with odd characters included', async () => {
    const keys = ['shots/b/2.png', 'shots/a/1.png', 'shots/a/sp ace+plus(1)!.png', 'other/x.png'];
    for (const [i, k] of keys.entries()) await plain.put(k, Buffer.from(`bytes-${i}`), { contentType: 'image/png' });
    expect((await plain.get('shots/a/sp ace+plus(1)!.png'))?.toString()).toBe('bytes-2');
    expect(await plain.get('shots/missing.png')).toBeNull();
    expect(await plain.list('shots/')).toEqual(['shots/a/1.png', 'shots/a/sp ace+plus(1)!.png', 'shots/b/2.png']);
    expect(await plain.list('none/')).toEqual([]);
  });

  it('board: a screenshot round-trips through S3ObjectStore', async () => {
    const store = new S3ObjectStore(plain);
    const png = randomBytes(2048);
    await store.put('screenshots/acc_1/run_1.png', png, 'image/png');
    expect((await store.get('screenshots/acc_1/run_1.png'))?.equals(png)).toBe(true);
    await expect(store.put('../escape.png', png, 'image/png')).rejects.toThrow(/bad object key/);
  });

  it('If-None-Match: * refuses to replace a key that exists (412)', async () => {
    await plain.put('once/k.json', Buffer.from('one'), { ifNoneMatch: true });
    const err = await plain.put('once/k.json', Buffer.from('two'), { ifNoneMatch: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3Error);
    expect((err as S3Error).status).toBe(412);
    expect((await plain.get('once/k.json'))?.toString()).toBe('one');
  });

  it('audit: heads are write-once (same bytes OK, other bytes refused) and list in order', async () => {
    const store = new S3HeadStore(plain);
    await store.put(head(2));
    await store.put(head(1));
    await store.put(head(2)); // the same bytes again: a push that crashed before it was recorded
    await expect(store.put(head(2, 'b'.repeat(64)))).rejects.toThrow(/write-once/);
    await store.putKey('k1', 'PEM-1\n');
    await store.putKey('k1', 'PEM-1\n');
    await expect(store.putKey('k1', 'PEM-2\n')).rejects.toThrow(/write-once/);
    expect((await store.list()).map((h) => [h.seq, h.hash[0]])).toEqual([
      [1, 'a'],
      [2, 'a'],
    ]);
    expect(await store.publicKey('k1')).toBe('PEM-1\n');
    expect(await store.publicKey('nope')).toBeNull();
  });

  it('a bucket made with object lock: heads are COMPLIANCE-locked and their versions cannot be deleted', async () => {
    expect(await plain.objectLock()).toBeNull();
    expect(await locked.createBucket({ objectLock: true })).toBe('created');
    expect(await locked.objectLock()).toBe('Enabled');

    const store = new S3HeadStore(locked, 1);
    await store.put(head(7));
    await store.put(head(7));
    await expect(store.put(head(7, 'c'.repeat(64)))).rejects.toThrow(/write-once/);

    const key = 'heads/000000000007.json';
    const ret = await locked.request('GET', key, { query: { retention: '' } });
    const xml = await ret.text();
    expect(ret.status).toBe(200);
    expect(xml).toMatch(/<Mode>COMPLIANCE<\/Mode>/);

    // Find the object's version and try to delete it for good: the lock refuses.
    const vres = await locked.request('GET', undefined, { query: { versions: '', prefix: key } });
    const versionId = /<VersionId>([^<]+)<\/VersionId>/.exec(await vres.text())?.[1];
    expect(versionId).toBeTruthy();
    const del = await locked.request('DELETE', key, { query: { versionId: versionId! } });
    await del.arrayBuffer();
    expect(del.status).toBe(403);
    expect((await locked.get(key))?.toString()).toContain('"seq":7');
  });

  it('s3FromConfig reads the credentials file, and is off without a bucket', async () => {
    const cred = join(dir, 's3');
    writeFileSync(cred, `access_key_id=${accessKeyId}\nsecret_access_key=${secretAccessKey}\n`, { mode: 0o600 });
    expect(s3FromConfig({ S3_BUCKET: '' })).toBeNull();
    const s3 = s3FromConfig({ S3_BUCKET: plain.cfg.bucket, S3_ENDPOINT: endpoint, S3_CREDENTIALS_FILE: cred });
    expect((await s3!.get('once/k.json'))?.toString()).toBe('one');
    writeFileSync(cred, 'access_key_id=only\n');
    expect(() => s3FromConfig({ S3_BUCKET: plain.cfg.bucket, S3_ENDPOINT: endpoint, S3_CREDENTIALS_FILE: cred })).toThrow(/needs/);
  });

  it('deploy/s3-bucket.ts makes both buckets (heads with object lock), runs again safely, and refuses a heads bucket without lock', async () => {
    const cred = join(dir, 's3-buckets');
    writeFileSync(cred, `access_key_id=${accessKeyId}\nsecret_access_key=${secretAccessKey}\n`, { mode: 0o600 });
    const env = {
      S3_ENDPOINT: endpoint,
      S3_BUCKET_SCREENSHOTS: `vha-shots-${run}`,
      S3_BUCKET_HEADS: `vha-heads-${run}`,
      S3_SCREENSHOTS_CREDENTIALS: cred,
    };
    const made = await ensureBuckets(env);
    // versitygw's answer to the lifecycle rule is printed, not assumed (Vultr's is checked by the first deploy).
    process.stdout.write(`s3-test: screenshots expiry on versitygw: ${made[0]!.expiry}\n`);
    expect(made.map(({ expiry: _, ...b }) => b)).toEqual([
      { role: 'screenshots', bucket: `vha-shots-${run}`, result: 'created', objectLock: null },
      { role: 'heads', bucket: `vha-heads-${run}`, result: 'created', objectLock: 'Enabled' },
    ]);
    expect(made[0]!.expiry).toMatch(/^(after 2 days|MISSING: .*)$/);
    expect(made[1]!.expiry).toBe('none');
    expect((await ensureBuckets(env)).map((r) => r.result)).toEqual(['exists', 'exists']);
    // A heads bucket made without lock (here: the plain one) can't be fixed afterwards.
    await expect(ensureBuckets({ ...env, S3_BUCKET_HEADS: plain.cfg.bucket })).rejects.toThrow(/without object lock/);
    await expect(ensureBuckets({ ...env, S3_BUCKET_HEADS: env.S3_BUCKET_SCREENSHOTS })).rejects.toThrow(/must differ/);
    await expect(ensureBuckets({ S3_ENDPOINT: endpoint })).rejects.toThrow(/not set/);
  });
});
