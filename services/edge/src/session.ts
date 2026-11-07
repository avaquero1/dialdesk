import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { SessionClaims } from '@app/contracts';

/**
 * Verifies accounts' session JWTs with the public key only. The format is fixed: three base64url parts, a header of
 * exactly {alg: "EdDSA", typ: "JWT", kid}, an Ed25519 signature, and claims that pass SessionClaims (strict). Anything
 * else (alg "none", another alg, an unknown kid, extra header fields, a bad signature, an expired token) is null.
 */
export type SessionKeys = Map<string, KeyObject>;

const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN = 2048;

/** The key id accounts puts in the header: sha256 of the raw public key, base64url, first 16 characters. */
export const kidOf = (x: string) => createHash('sha256').update(Buffer.from(x, 'base64url')).digest('base64url').slice(0, 16);

/** EDGE_SESSION_PUBLIC_KEYS: comma-separated raw Ed25519 public keys, base64url (two during a rotation). */
export function sessionKeys(list: string): SessionKeys {
  const out: SessionKeys = new Map();
  for (const x of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!B64URL.test(x) || Buffer.from(x, 'base64url').length !== 32) throw new Error('EDGE_SESSION_PUBLIC_KEYS: each key is 32 bytes, base64url');
    out.set(kidOf(x), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }));
  }
  if (!out.size) throw new Error('EDGE_SESSION_PUBLIC_KEYS is empty');
  return out;
}

function json(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function verifySession(token: string | undefined, keys: SessionKeys, nowSec: number, leewaySec = 30): SessionClaims | null {
  if (!token || token.length > MAX_TOKEN) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return null;
  const [h, p, s] = parts as [string, string, string];
  const head = json(h) as Record<string, unknown> | null;
  if (!head || typeof head !== 'object' || Array.isArray(head)) return null;
  if (Object.keys(head).sort().join(',') !== 'alg,kid,typ' || head.alg !== 'EdDSA' || head.typ !== 'JWT' || typeof head.kid !== 'string') return null;
  const key = keys.get(head.kid);
  if (!key) return null;
  const sig = Buffer.from(s, 'base64url');
  if (sig.length !== 64 || !verify(null, Buffer.from(`${h}.${p}`), key, sig)) return null;
  const claims = SessionClaims.safeParse(json(p));
  if (!claims.success) return null;
  if (claims.data.exp <= nowSec || claims.data.iat > nowSec + leewaySec || claims.data.exp <= claims.data.iat) return null;
  return claims.data;
}

/**
 * "Is this session still valid?" (logout revokes it), asked of accounts and cached briefly. A valid answer is kept for
 * `ttlMs`; a revoked one until the token expires. Calls for the same session at once share one request.
 */
export class RevocationCache {
  private readonly seen = new Map<string, { valid: boolean; until: number }>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  constructor(
    private readonly ask: (sessionId: string) => Promise<boolean>,
    private readonly ttlMs = 15_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async valid(sessionId: string, expSec: number): Promise<boolean> {
    const hit = this.seen.get(sessionId);
    if (hit && hit.until > this.clock()) return hit.valid;
    let p = this.inflight.get(sessionId);
    if (!p) {
      p = this.ask(sessionId).finally(() => this.inflight.delete(sessionId));
      this.inflight.set(sessionId, p);
    }
    const valid = await p;
    if (this.seen.size > 50_000) this.seen.clear();
    this.seen.set(sessionId, { valid, until: valid ? this.clock() + this.ttlMs : expSec * 1000 });
    return valid;
  }

  /** On logout through this edge: refuse the session at once, without waiting for the cache. */
  revoke(sessionId: string, expSec: number) {
    this.seen.set(sessionId, { valid: false, until: expSec * 1000 });
  }
}
