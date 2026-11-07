/**
 * A small S3 client for Vultr Object Storage (S3 API, Ceph RGW) and any S3-compatible server: path-style requests
 * signed with AWS Signature V4 on node:crypto and fetch. No SDK. Only what board and audit need: put (optionally
 * write-once with If-None-Match and object lock), get, list, and create bucket.
 *
 * Credentials come from a file (one per service, mounted only into it):
 *   access_key_id=...
 *   secret_access_key=...
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type S3Config = {
  /** e.g. https://ewr1.vultrobjects.com */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  timeoutMs?: number;
};

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type PutOptions = {
  contentType?: string;
  /** Refuse when the key exists (If-None-Match: *). The server answers 412. */
  ifNoneMatch?: boolean;
  /** Object lock: the object can't be deleted or overwritten until then (needs a bucket made with object lock). */
  lockUntil?: Date;
  lockMode?: 'COMPLIANCE' | 'GOVERNANCE';
};

/** Reads `access_key_id=` and `secret_access_key=` lines. Throws when either is missing. */
export function readS3Credentials(path: string): { accessKeyId: string; secretAccessKey: string } {
  const kv = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([a-z_]+)\s*=\s*(\S+)\s*$/.exec(line);
    if (m) kv.set(m[1]!, m[2]!);
  }
  const accessKeyId = kv.get('access_key_id');
  const secretAccessKey = kv.get('secret_access_key');
  if (!accessKeyId || !secretAccessKey) throw new Error(`s3: ${path} needs access_key_id= and secret_access_key= lines`);
  return { accessKeyId, secretAccessKey };
}

const sha256hex = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
// RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone).
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (key: string) => key.split('/').map(enc).join('/');
const xmlText = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlText(m[1]!) : undefined;
};

export class S3Client {
  private readonly base: URL;
  constructor(readonly cfg: S3Config) {
    this.base = new URL(cfg.endpoint);
    if (!/^https?:$/.test(this.base.protocol)) throw new Error(`s3: endpoint must be http(s): ${cfg.endpoint}`);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket)) throw new Error(`s3: bad bucket name ${cfg.bucket}`);
  }

  /** A signed request. `key` undefined = the bucket itself. */
  async request(
    method: string,
    key: string | undefined,
    opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: Buffer } = {},
  ): Promise<Response> {
    const body = opts.body ?? Buffer.alloc(0);
    const path = `/${this.cfg.bucket}${key === undefined ? '' : `/${encPath(key)}`}`;
    const query = Object.entries(opts.query ?? {})
      .map(([k, v]) => [enc(k), enc(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256hex(body);
    const headers: Record<string, string> = {
      host: this.base.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      path,
      query,
      names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(''),
      names.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${day}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, day), this.cfg.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    delete headers.host; // fetch sets it (the same value)
    const url = `${this.base.origin}${path}${query ? `?${query}` : ''}`;
    return fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(body),
      redirect: 'error',
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
    });
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = res.status === 304 || res.status === 204 ? '' : await res.text().catch(() => '');
    const code = tag(text, 'Code') ?? `http_${res.status}`;
    // The body may echo the key or bucket; it never holds a credential. Keep it short anyway.
    throw new S3Error(res.status, code, `s3 ${what}: ${res.status} ${code}`);
  }

  async put(key: string, bytes: Buffer, o: PutOptions = {}): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': o.contentType ?? 'application/octet-stream',
      // Object lock PUTs must carry an integrity header; send it always.
      'content-md5': createHash('md5').update(bytes).digest('base64'),
    };
    if (o.ifNoneMatch) headers['if-none-match'] = '*';
    if (o.lockUntil) {
      headers['x-amz-object-lock-mode'] = o.lockMode ?? 'COMPLIANCE';
      headers['x-amz-object-lock-retain-until-date'] = o.lockUntil.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    const res = await this.request('PUT', key, { headers, body: bytes });
    if (!res.ok) await this.fail(res, `put ${key}`);
    await res.arrayBuffer();
  }

  /** null when the key isn't there. */
  async get(key: string): Promise<Buffer | null> {
    const res = await this.request('GET', key);
    if (res.status === 404) {
      await res.arrayBuffer();
      return null;
    }
    if (!res.ok) await this.fail(res, `get ${key}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Every key under `prefix` (ListObjectsV2, all pages), in the server's (lexical) order. */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < 10_000; page++) {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const res = await this.request('GET', undefined, { query });
      if (!res.ok) await this.fail(res, `list ${prefix}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const k = tag(m[1]!, 'Key');
        if (k !== undefined) keys.push(k);
      }
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
      if (!token) return keys;
    }
    throw new Error('s3: list did not end');
  }

  /** Creates the bucket (idempotent for its owner). objectLock: versioning plus object lock, set at creation only. */
  async createBucket(o: { objectLock?: boolean } = {}): Promise<'created' | 'exists'> {
    const headers: Record<string, string> = {};
    if (o.objectLock) headers['x-amz-bucket-object-lock-enabled'] = 'true';
    const res = await this.request('PUT', undefined, { headers });
    if (res.ok) {
      await res.arrayBuffer();
      return 'created';
    }
    const text = await res.text().catch(() => '');
    const code = tag(text, 'Code') ?? `http_${res.status}`;
    if (code === 'BucketAlreadyOwnedByYou') return 'exists';
    throw new S3Error(res.status, code, `s3 create bucket ${this.cfg.bucket}: ${res.status} ${code}`);
  }

  /** The bucket's object lock setting: 'Enabled', or null when it has none. */
  async objectLock(): Promise<string | null> {
    const res = await this.request('GET', undefined, { query: { 'object-lock': '' } });
    if (res.status === 404) {
      await res.arrayBuffer();
      return null;
    }
    const text = await res.text();
    if (!res.ok) {
      const code = tag(text, 'Code') ?? '';
      if (/ObjectLockConfigurationNotFound/i.test(code)) return null;
      throw new S3Error(res.status, code, `s3 object-lock ${this.cfg.bucket}: ${res.status} ${code}`);
    }
    return tag(text, 'ObjectLockEnabled') ?? null;
  }
}

/** The S3 settings of a service, from its `<SVC>_S3_*` config. null when no bucket is set (use the local fallback). */
export function s3FromConfig(cfg: Record<string, unknown>): S3Client | null {
  const bucket = typeof cfg.S3_BUCKET === 'string' ? cfg.S3_BUCKET : '';
  if (!bucket) return null;
  const endpoint = String(cfg.S3_ENDPOINT ?? '');
  const credFile = String(cfg.S3_CREDENTIALS_FILE ?? '');
  if (!endpoint || !credFile) throw new Error('s3: S3_BUCKET is set, so S3_ENDPOINT and S3_CREDENTIALS_FILE are needed');
  return new S3Client({ endpoint, region: String(cfg.S3_REGION || 'us-east-1'), bucket, ...readS3Credentials(credFile) });
}
