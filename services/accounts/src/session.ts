import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { SessionClaims } from '@app/contracts';

/**
 * Session tokens: compact JWTs signed with Ed25519 (alg EdDSA). accounts holds the private key; edge holds only the
 * public key (EDGE_SESSION_PUBLIC_KEYS) and verifies. The key id is the first 16 base64url characters of the sha256
 * of the raw public key, so edge can hold the old and new key during a rotation.
 */
export interface SigningKey {
  privateKey: KeyObject;
  /** The raw 32-byte public key, base64url: what edge is configured with. */
  publicKey: string;
  kid: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signingKeyFrom(privateKey: KeyObject): SigningKey {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the session key must be Ed25519');
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x as string;
  return { privateKey, publicKey, kid: kidOf(publicKey) };
}

export function kidOf(publicKeyB64url: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyB64url, 'base64url')).digest('base64url').slice(0, 16);
}

/**
 * Loads the PEM (PKCS#8) private key file. Refuses a file that its group or others can read: the key is the one
 * secret accounts holds, and it never goes in env, the repo or a log.
 */
export function loadSigningKey(file: string): SigningKey {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`session key file is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  return signingKeyFrom(createPrivateKey(readFileSync(file)));
}

export function signSession(claims: SessionClaims, key: SigningKey): string {
  const body = SessionClaims.parse(claims);
  const head = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: key.kid }));
  const input = `${head}.${b64url(JSON.stringify(body))}`;
  return `${input}.${b64url(sign(null, Buffer.from(input), key.privateKey))}`;
}
