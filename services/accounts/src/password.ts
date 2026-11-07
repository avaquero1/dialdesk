import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Password hashes: argon2id from node:crypto (no native module), stored in the PHC string format
 * `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>` (unpadded base64), so the cost can rise later and old
 * hashes still verify. Defaults are OWASP's first argon2id setting: 46 MiB, 1 pass, 1 lane.
 */
export interface Argon2Cost {
  memory: number;
  passes: number;
  parallelism: number;
}
export const DEFAULT_COST: Argon2Cost = { memory: 47104, passes: 1, parallelism: 1 };
/** For tests only: the format and the checks stay the same, the work is small. */
export const TEST_COST: Argon2Cost = { memory: 1024, passes: 1, parallelism: 1 };

const TAG = 32;
const SALT = 16;
// A stored hash outside these bounds is refused instead of run (a tampered row must not become a memory bomb).
const MAX = { memory: 262144, passes: 10, parallelism: 8 };

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

function derive(password: string, salt: Buffer, cost: Argon2Cost, tagLength = TAG): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, tagLength, ...cost }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string, cost: Argon2Cost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(SALT);
  const hash = await derive(password, salt, cost);
  return `$argon2id$v=19$m=${cost.memory},t=${cost.passes},p=${cost.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,88})\$([A-Za-z0-9+/]{16,88})$/;

/** Constant-time compare. A malformed or out-of-bounds stored hash verifies false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = PHC.exec(stored);
  if (!m) return false;
  const cost = { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) };
  if (cost.memory > MAX.memory || cost.passes > MAX.passes || cost.parallelism > MAX.parallelism || cost.passes < 1 || cost.parallelism < 1) return false;
  if (cost.memory < 8 * cost.parallelism) return false;
  const salt = Buffer.from(m[4]!, 'base64');
  const want = Buffer.from(m[5]!, 'base64');
  if (want.length < 16) return false;
  const got = await derive(password, salt, cost, want.length);
  return timingSafeEqual(got, want);
}

/**
 * A hash of a random password with the same cost, so a login for an unknown email takes as long as one for a
 * known email (no account discovery by timing).
 */
export async function dummyHash(cost: Argon2Cost = DEFAULT_COST): Promise<string> {
  return hashPassword(randomBytes(24).toString('base64'), cost);
}
