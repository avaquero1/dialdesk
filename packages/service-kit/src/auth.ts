import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Caller } from '@app/contracts';

/** A callee stores only what checks a caller's token: its sha256. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Parses `<SVC>_CALLERS` ("edge:<hex>,agent:<hex>") into caller -> hash. */
export function parseCallers(spec: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, hex] = part.split(':');
    if (!name || !hex || !/^[0-9a-f]{64}$/.test(hex)) throw new Error(`bad CALLERS entry "${part.slice(0, 20)}…"`);
    out.set(name, Buffer.from(hex, 'hex'));
  }
  return out;
}

/** Who presented this bearer token, or null. Compares against every known hash in constant time. */
export function identifyCaller(authorization: string | undefined, callers: Map<string, Buffer>): Caller | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const got = Buffer.from(hashToken(authorization.slice(7)), 'hex');
  let found: string | null = null;
  for (const [name, want] of callers) if (timingSafeEqual(got, want)) found = name;
  return found as Caller | null;
}
