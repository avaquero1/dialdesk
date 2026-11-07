/**
 * The sealed box the browser uses to send a private key to connections, so edge only ever sees an opaque body.
 *
 *   sealed = 0x01 | ephemeral X25519 public key (32) | IV (12) | AES-256-GCM ciphertext and tag
 *   key    = HKDF-SHA256(X25519(ephemeral, connections), salt = ephemeral public | connections public, info = SEAL_INFO)
 *   AAD    = "<account_id>\n<key_id>", so a sealed key can't be replayed into another account or under another key id.
 *
 * WebCrypto only (X25519, HKDF, AES-GCM): the same file runs in the browser (sealing) and in connections (opening).
 */
const subtle = globalThis.crypto.subtle;
const VERSION = 1;
export const SEAL_INFO = 'vha/connections/seal/v1';
const enc = new TextEncoder();
/** Bytes backed by a plain ArrayBuffer, which is what WebCrypto takes. */
type Bytes = Uint8Array<ArrayBuffer>;

export const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
export const unb64 = (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const cat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};
export const sealAad = (account_id: string, key_id: string): Bytes => enc.encode(`${account_id}\n${key_id}`);

async function boxKey(shared: ArrayBuffer, ephPub: Bytes, recipientPub: Bytes, usage: 'encrypt' | 'decrypt') {
  if (new Uint8Array(shared).every((b) => b === 0)) throw new SealError('low-order public key');
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: cat(ephPub, recipientPub), info: enc.encode(SEAL_INFO) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

/** Browser side: seal `plaintext` to connections' public key (base64 of the raw 32 bytes from GET /public-key). */
export async function seal(recipientPublicKeyB64: string, plaintext: string, aad: Bytes): Promise<string> {
  const recipientPub = unb64(recipientPublicKeyB64);
  if (recipientPub.length !== 32) throw new SealError('bad public key');
  const recipient = await subtle.importKey('raw', recipientPub, { name: 'X25519' }, false, []);
  const eph = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
  const ephPub = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const shared = await subtle.deriveBits({ name: 'X25519', public: recipient }, eph.privateKey, 256);
  const key = await boxKey(shared, ephPub, recipientPub, 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, enc.encode(plaintext)));
  return b64(cat(Uint8Array.of(VERSION), ephPub, iv, ct));
}

/** connections' side: the X25519 key pair, from 32 secret bytes (derived from the master key). */
export async function sealKeyPair(secret32: Uint8Array) {
  if (secret32.length !== 32) throw new SealError('the seal secret must be 32 bytes');
  // PKCS#8 for X25519 (RFC 8410): a fixed 16-byte header, then the 32-byte private key.
  const pkcs8 = cat(Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]), secret32);
  const privateKey = await subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', privateKey);
  const publicRaw: Bytes = Uint8Array.from(atob(jwk.x!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return { privateKey, publicRaw, publicKeyB64: b64(publicRaw) };
}

/** connections' side: open a sealed box. Throws SealError on anything malformed, tampered or bound to other AAD. */
export async function open(pair: { privateKey: CryptoKey; publicRaw: Bytes }, sealedB64: string, aad: Bytes): Promise<string> {
  let sealed: Bytes;
  try {
    sealed = unb64(sealedB64);
  } catch {
    throw new SealError('not base64');
  }
  if (sealed.length < 1 + 32 + 12 + 16 + 1 || sealed[0] !== VERSION) throw new SealError('not a v1 sealed box');
  const ephPub = sealed.subarray(1, 33);
  const iv = sealed.subarray(33, 45);
  const ct = sealed.subarray(45);
  let eph: CryptoKey;
  try {
    eph = await subtle.importKey('raw', ephPub, { name: 'X25519' }, false, []);
  } catch {
    throw new SealError('bad ephemeral key');
  }
  let shared: ArrayBuffer;
  try {
    shared = await subtle.deriveBits({ name: 'X25519', public: eph }, pair.privateKey, 256);
  } catch {
    // WebCrypto refuses a low-order point (an all-zero shared secret) itself.
    throw new SealError('low-order public key');
  }
  const key = await boxKey(shared, ephPub, pair.publicRaw, 'decrypt');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct));
  } catch {
    throw new SealError('the sealed box does not open (tampered, wrong key, or another account or key id)');
  }
}
