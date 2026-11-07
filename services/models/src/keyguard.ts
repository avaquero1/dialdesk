import { hash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * "Never passes a prompt that contains a key." Two checks:
 * 1. Shapes: a PEM private key block.
 * 2. Fingerprints: the SHA-256 of every WINDOW-character slice of each known key, at every offset. The prompt's slices
 *    are hashed every STRIDE characters; one that matches refuses the prompt. So a key is caught whole, or as a
 *    fragment of WINDOW + STRIDE - 1 characters or more, anywhere in the prompt.
 *    The fingerprints come from the key files models holds (its Vultr key) and from fingerprint files made elsewhere
 *    (`npm run fingerprint -w services/models -- <key file>`), so other services' keys are caught without models
 *    ever holding them. A fingerprint file holds hashes only; no key can be read back from it.
 * The key itself is never kept here, and a refusal never says which slice matched.
 */
export const WINDOW = 16;
export const STRIDE = 4;
const HASH_HEX = 32; // 128 bits of each SHA-256 is plenty to tell slices apart
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
/** Runs of key characters. A key in a prompt shows up inside one of them. */
const RUN = /[A-Za-z0-9_\-+/=.~:]+/g;

export interface FingerprintFile {
  v: 1;
  name: string;
  window: number;
  hashes: string[];
}

const sliceHash = (s: string) => hash('sha256', s, 'hex').slice(0, HASH_HEX);

/** The fingerprints of one key: every slice of `window` characters (the whole key when it is shorter). */
export function fingerprint(name: string, key: string): FingerprintFile {
  const k = key.trim();
  const w = Math.min(WINDOW, k.length);
  const hashes = new Set<string>();
  for (let i = 0; i + w <= k.length; i++) hashes.add(sliceHash(k.slice(i, i + w)));
  return { v: 1, name, window: w, hashes: [...hashes].sort() };
}

export class KeyGuard {
  /** window length -> slice hashes */
  private byWindow = new Map<number, Set<string>>();
  private names = new Set<string>();

  add(fp: FingerprintFile) {
    if (fp.v !== 1 || !Number.isInteger(fp.window) || fp.window < 8) throw new Error(`fingerprint ${fp.name}: bad file`);
    const set = this.byWindow.get(fp.window) ?? new Set<string>();
    for (const h of fp.hashes) set.add(h);
    this.byWindow.set(fp.window, set);
    this.names.add(fp.name);
  }

  addKey(name: string, key: string) {
    if (key.trim().length >= 8) this.add(fingerprint(name, key));
  }

  addFingerprintFile(path: string) {
    this.add(JSON.parse(readFileSync(path, 'utf8')) as FingerprintFile);
  }

  /** Names of the keys it checks for (never the keys). */
  get keys(): string[] {
    return [...this.names].sort();
  }

  /** True when `text` holds a private key block or a slice of a known key. */
  holdsKey(text: string): boolean {
    if (PEM.test(text)) return true;
    if (!this.byWindow.size) return false;
    for (const m of text.matchAll(RUN)) {
      const run = m[0];
      for (const [w, set] of this.byWindow) {
        // a key shorter than a window is only caught whole
        const stride = w < WINDOW ? 1 : STRIDE;
        for (let i = 0; i + w <= run.length; i += stride) if (set.has(sliceHash(run.slice(i, i + w)))) return true;
      }
    }
    return false;
  }
}
