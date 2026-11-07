import { constants, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { getOnlyFetch, type GetOnlyFetch, type Route } from './getonly.ts';
import { sha256hex } from './vault.ts';

/**
 * Kalshi's Trade API v2, read only. Bases from docs.kalshi.com ("API Environments", checked 2026-11-07): the
 * `external-api` hosts are the recommended ones; demo is the fake-money exchange (its keys don't work on prod).
 */
export const KALSHI_BASES = {
  prod: 'https://external-api.kalshi.com/trade-api/v2',
  demo: 'https://external-api.demo.kalshi.co/trade-api/v2',
} as const;
export type KalshiEnv = keyof typeof KALSHI_BASES;

/** Every Kalshi path connections may call, all GET. Nothing that places, amends or cancels an order is here. */
export const KALSHI_GET_PATHS = ['/api_keys', '/portfolio/balance', '/portfolio/positions'] as const;
export type KalshiPath = (typeof KALSHI_GET_PATHS)[number];

export const KALSHI_ROUTES: Route[] = Object.values(KALSHI_BASES).map((b) => {
  const u = new URL(b);
  return { origin: u.origin, base: u.pathname, paths: KALSHI_GET_PATHS };
});

/**
 * The scopes a key may have and still be connected. An allowlist, not a denylist: `write`, `write::trade`,
 * `write::transfer` and any scope Kalshi adds later are refused. A key with no scopes at all is refused too.
 */
export const READ_ONLY_SCOPES: ReadonlySet<string> = new Set(['read', 'read::portfolio_balance']);

export const ApiKeysResponse = z.object({
  api_keys: z.array(
    z.object({
      api_key_id: z.string(),
      name: z.string().optional(),
      key_type: z.string().optional(),
      scopes: z.array(z.string()),
      subaccount: z.number().int().nullable().optional(),
    }),
  ),
});
export type ApiKeysResponse = z.infer<typeof ApiKeysResponse>;

export type ScopeVerdict =
  | { ok: true; scopes: string[] }
  | { ok: false; reason: 'key_not_listed' | 'write_scope' | 'unknown_scope' | 'no_scope' | 'key_type_mismatch'; scopes: string[] };

/** D1: find the pasted key in its own GET /api_keys answer and refuse anything that isn't read only. */
export function checkScopes(resp: ApiKeysResponse, keyId: string, keyType: 'ed25519' | 'rsa'): ScopeVerdict {
  const k = resp.api_keys.find((x) => x.api_key_id === keyId);
  if (!k) return { ok: false, reason: 'key_not_listed', scopes: [] };
  const scopes = [...k.scopes];
  if (scopes.length === 0) return { ok: false, reason: 'no_scope', scopes };
  if (scopes.some((s) => s === 'write' || s.startsWith('write'))) return { ok: false, reason: 'write_scope', scopes };
  if (scopes.some((s) => !READ_ONLY_SCOPES.has(s))) return { ok: false, reason: 'unknown_scope', scopes };
  if (k.key_type && k.key_type !== keyType) return { ok: false, reason: 'key_type_mismatch', scopes };
  return { ok: true, scopes };
}

export class KeyFormatError extends Error {
  name = 'KeyFormatError';
}

/** Parse a pasted PEM (PKCS#8, or PKCS#1 for RSA) and check it is the type the user picked. */
export function parsePrivateKey(pem: string, keyType: 'ed25519' | 'rsa'): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new KeyFormatError('not a PEM private key (or it is passphrase-protected)');
  }
  const t = key.asymmetricKeyType;
  if (keyType === 'ed25519' && t !== 'ed25519') throw new KeyFormatError(`expected an Ed25519 key, got ${t}`);
  if (keyType === 'rsa') {
    if (t !== 'rsa' && t !== 'rsa-pss') throw new KeyFormatError(`expected an RSA key, got ${t}`);
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new KeyFormatError('RSA keys must be 2048 bits or more');
  }
  return key;
}

/** sha256 of the public key (SPKI DER): what audit records instead of the key. */
export const keyFingerprint = (key: KeyObject) => sha256hex(createPublicKey(key).export({ type: 'spki', format: 'der' }));

/** Kalshi's signature: base64 of Ed25519, or RSA-PSS SHA-256 (salt = digest length), over timestamp + method + path. */
export function signRequest(key: KeyObject, timestampMs: string, method: 'GET', fullPath: string): string {
  const msg = Buffer.from(timestampMs + method + fullPath);
  if (key.asymmetricKeyType === 'ed25519') return sign(null, msg, key).toString('base64');
  return sign('sha256', msg, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }).toString('base64');
}

export class KalshiError extends Error {
  name = 'KalshiError';
  constructor(
    readonly status: number,
    readonly kind: 'auth' | 'retryable' | 'other',
  ) {
    super(`kalshi answered ${status}`);
  }
}

const Balance = z.object({ balance: z.number().int(), portfolio_value: z.number().int().optional(), updated_ts: z.number().int().optional() });
const MarketPosition = z.object({
  ticker: z.string(),
  position_fp: z.string().optional(),
  position: z.number().optional(),
  market_exposure_dollars: z.string().optional(),
  market_exposure: z.number().optional(),
});
const Positions = z.object({ market_positions: z.array(MarketPosition).default([]), cursor: z.string().nullable().optional() });
export type KalshiBalance = z.infer<typeof Balance>;
export type KalshiMarketPosition = z.infer<typeof MarketPosition>;

export interface KalshiClientOpts {
  env: KalshiEnv;
  keyId: string;
  key: KeyObject;
  /** The raw fetch underneath; always wrapped in the GET-only guard. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** A Kalshi client that can only read: three GET paths through the GET-only guard. */
export function kalshiClient(o: KalshiClientOpts) {
  const base = KALSHI_BASES[o.env];
  const basePath = new URL(base).pathname;
  const send: GetOnlyFetch = getOnlyFetch(KALSHI_ROUTES, o.fetch ?? fetch);
  const get = async <T>(path: KalshiPath, schema: z.ZodType<T>, query: Record<string, string> = {}, signal?: AbortSignal): Promise<T> => {
    const ts = String((o.now ?? Date.now)());
    const qs = new URLSearchParams(query).toString();
    const headers = {
      'KALSHI-ACCESS-KEY': o.keyId,
      'KALSHI-ACCESS-TIMESTAMP': ts,
      // The query string is not signed (Kalshi's docs: strip `?` and after).
      'KALSHI-ACCESS-SIGNATURE': signRequest(o.key, ts, 'GET', basePath + path),
      accept: 'application/json',
    };
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 10_000);
    const res = await send(`${base}${path}${qs ? `?${qs}` : ''}`, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) {
      await res.body?.cancel();
      throw new KalshiError(res.status, res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 || res.status >= 500 ? 'retryable' : 'other');
    }
    return schema.parse(await res.json());
  };
  return {
    apiKeys: (signal?: AbortSignal) => get('/api_keys', ApiKeysResponse, {}, signal),
    balance: (signal?: AbortSignal) => get('/portfolio/balance', Balance, {}, signal),
    /** Open positions, following the cursor (at most 10 pages of 200). */
    async positions(signal?: AbortSignal) {
      const out: KalshiMarketPosition[] = [];
      let cursor = '';
      for (let page = 0; page < 10; page++) {
        const r = await get('/portfolio/positions', Positions, { limit: '200', count_filter: 'position', ...(cursor && { cursor }) }, signal);
        out.push(...r.market_positions);
        cursor = r.cursor ?? '';
        if (!cursor) break;
      }
      return out;
    },
  };
}
export type KalshiClient = ReturnType<typeof kalshiClient>;
