/**
 * Where screenshots go: Object Storage behind an interface. Dev and tests use a local folder or memory; the
 * Vultr Object Storage client (S3 API) plugs in behind the same interface once the bucket exists.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface ObjectStore {
  readonly kind: string;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** null when the key isn't there. */
  get(key: string): Promise<Buffer | null>;
}

/** Keys are made by board from ids (logic.screenshotKey); refuse anything else. */
export function checkKey(key: string): string {
  if (!/^[a-z]+(\/[A-Za-z0-9_-]+)+\.png$/.test(key)) throw new Error(`bad object key ${key}`);
  return key;
}

export class MemoryObjectStore implements ObjectStore {
  readonly kind = 'memory';
  readonly objects = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer) {
    this.objects.set(checkKey(key), Buffer.from(bytes));
  }
  async get(key: string) {
    return this.objects.get(checkKey(key)) ?? null;
  }
}

/** A local folder standing in for the bucket (dev only). Writes go to a temp file first, then rename. */
export class LocalDirObjectStore implements ObjectStore {
  readonly kind = 'local';
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    const p = resolve(join(this.root, checkKey(key)));
    if (!p.startsWith(this.root + sep)) throw new Error(`object key escapes the folder: ${key}`);
    return p;
  }
  async put(key: string, bytes: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(`${p}.tmp`, bytes, { mode: 0o600 });
    await rename(`${p}.tmp`, p);
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const isPng = (b: Buffer) => b.length > PNG_MAGIC.length && b.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
