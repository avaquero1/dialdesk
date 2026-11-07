import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SignedHead } from '@app/contracts';
import type { z } from 'zod';
import { headMessage, sha256 } from './chain.ts';

type Head = z.infer<typeof SignedHead>;
export type UnsignedHead = { seq: number; hash: string; signed_at: string };

/** key_id = "ed25519:" + the first 16 hex of sha256 of the public key (SPKI DER). */
export const keyIdOf = (pub: KeyObject) => `ed25519:${sha256(pub.export({ type: 'spki', format: 'der' })).slice(0, 16)}`;

/**
 * audit's Ed25519 signing key. It lives in one file (PKCS#8 PEM, mode 600) that only audit reads. In dev
 * `make dev-secrets` writes it into deploy/.dev/ (gitignored); `generate: true` makes it when it is missing.
 * The public key is published next to the heads (keys/<key_id>.pem), so anyone can check them.
 */
export class Signer {
  readonly keyId: string;
  readonly publicPem: string;
  private readonly pub: KeyObject;

  private constructor(private readonly priv: KeyObject) {
    this.pub = createPublicKey(priv);
    this.keyId = keyIdOf(this.pub);
    this.publicPem = this.pub.export({ type: 'spki', format: 'pem' }).toString();
  }

  static fromFile(path: string, opts: { generate?: boolean } = {}): Signer {
    if (!existsSync(path)) {
      if (!opts.generate) throw new Error(`audit: no signing key at ${path}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, generatePem(), { mode: 0o600, flag: 'wx' });
    }
    const key = createPrivateKey(readFileSync(path));
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('audit: the signing key must be Ed25519');
    return new Signer(key);
  }

  static generate(): Signer {
    return new Signer(createPrivateKey(generatePem()));
  }

  sign(h: UnsignedHead): Head {
    const head = { ...h, key_id: this.keyId };
    return { ...head, alg: 'Ed25519', signature: sign(null, headMessage(head), this.priv).toString('base64'), pushed_at: null };
  }

  /** Checks a head's signature with this key, or with `publicPem` (a head signed by an earlier key). */
  check(h: Head, publicPem?: string): boolean {
    const key = publicPem ? createPublicKey(publicPem) : this.pub;
    if (!publicPem && h.key_id !== this.keyId) return false;
    if (publicPem && keyIdOf(key) !== h.key_id) return false;
    try {
      return verify(null, headMessage(h), key, Buffer.from(h.signature, 'base64'));
    } catch {
      return false;
    }
  }
}

export function generatePem(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}
