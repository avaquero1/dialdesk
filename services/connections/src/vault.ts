import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { sealKeyPair } from './seal.ts';

/**
 * The master key: 32 random bytes, base64 on one line, in a file only the connections container mounts
 * (production: /run/secrets/connections-master; dev: deploy/.dev/connections-master.key from `make dev-secrets`).
 * Two keys are derived from it with HKDF-SHA256: the X25519 seal key pair (what the browser seals to) and the
 * AES-256-GCM key that encrypts stored private keys at rest. The master key itself never leaves this module.
 */
export const VAULT_INFO = 'vha/connections/vault/v1';
export const SEAL_KEY_INFO = 'vha/connections/x25519/v1';

export function readMasterKey(path: string): { key: Buffer; looseMode: boolean } {
  const st = statSync(path);
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`the master key file ${path} must hold 32 bytes as base64`);
  return { key, looseMode: Boolean(st.mode & 0o077) };
}

export async function openVault(master: Buffer) {
  if (master.length !== 32) throw new Error('the master key must be 32 bytes');
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  const dataKey = derive(VAULT_INFO);
  const pair = await sealKeyPair(new Uint8Array(derive(SEAL_KEY_INFO)));
  return {
    seal: pair,
    /** Encrypt a secret at rest, bound to its row (AAD = connection id). Layout: IV (12) | ciphertext | tag (16). */
    encrypt(plaintext: string, rowId: string): Buffer {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', dataKey, iv);
      c.setAAD(Buffer.from(rowId));
      const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
      return Buffer.concat([iv, ct, c.getAuthTag()]);
    },
    decrypt(blob: Buffer, rowId: string): string {
      if (blob.length < 12 + 16) throw new Error('vault blob too short');
      const d = createDecipheriv('aes-256-gcm', dataKey, blob.subarray(0, 12));
      d.setAAD(Buffer.from(rowId));
      d.setAuthTag(blob.subarray(blob.length - 16));
      return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString('utf8');
    },
  };
}
export type Vault = Awaited<ReturnType<typeof openVault>>;

export const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
