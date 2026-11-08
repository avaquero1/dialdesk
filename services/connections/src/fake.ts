import { CONNECTIONS, newId, type Connection, type Numbers } from '@app/contracts';
import { HttpError, now, type AccountData, type Handlers } from '@app/service-kit';
import { fixtures } from '@app/testkit';
import { sealKeyPair } from './seal.ts';

/** Public on purpose: the fake holds no secret. */
const FAKE_SEED = new Uint8Array(32).fill(0x42);

export interface FakeDeps {
  /** Hands over the fake's per-account data, so a test can follow account deletes (followAccountDeletes). */
  accountData?: (d: AccountData) => void;
}
export async function fakeDepsFromEnv(): Promise<FakeDeps> {
  return {};
}

/**
 * In-memory connections. It opens no sealed key and calls no exchange. Its public key is a real X25519 key (from a
 * fixed, public seed), so the browser's seal() works against it. The read-scope check is simulated:
 * a Kalshi key id containing "write" is treated as a key with write scope and refused (403), like the real check
 * against fixtures/markets/kalshi/api_keys-write.json.
 */
export function fake(deps: FakeDeps = {}): Handlers<typeof CONNECTIONS> {
  const conns = new Map<string, Connection>();
  deps.accountData?.({
    accountIds: async () => [...new Set([...conns.values()].map((c) => c.account_id))],
    forget: async (account_id) => {
      let n = 0;
      for (const [id, c] of conns) if (c.account_id === account_id && conns.delete(id)) n++;
      return n;
    },
  });
  const mine = (id: string, account_id: string) => {
    const c = conns.get(id);
    if (!c || c.account_id !== account_id) throw new HttpError(404, 'not_found', 'no such connection');
    return c;
  };
  return {
    publicKey: async () => ({ alg: 'x25519-sealed-box', public_key: (await sealKeyPair(FAKE_SEED)).publicKeyB64 }),
    connect: ({ body }) => {
      if (body.exchange === 'kalshi' && body.key_id.includes('write'))
        throw new HttpError(403, 'write_scope', 'This key can trade. Make a read-only key and paste that one.');
      const c: Connection = {
        connection_id: newId('con'),
        account_id: body.account_id,
        exchange: body.exchange,
        label: body.exchange === 'kalshi' ? body.key_id.slice(0, 12) : `${body.wallet.slice(0, 6)}…${body.wallet.slice(-4)}`,
        scope: 'read',
        scope_verified: true,
        checked_at: now(),
        share_numbers: false,
        public_data: body.exchange === 'polymarket',
      };
      conns.set(c.connection_id, c);
      return c;
    },
    list: ({ query }) => ({ connections: [...conns.values()].filter((c) => c.account_id === query.account_id) }),
    setConsent: ({ params, body }) => {
      const c = mine(params.connection_id, body.account_id);
      c.share_numbers = body.share_numbers;
      return c;
    },
    remove: ({ params, query }) => {
      mine(params.connection_id, query.account_id);
      conns.delete(params.connection_id);
      return { ok: true };
    },
    numbers: ({ params, query }) => {
      const c = mine(params.connection_id, query.account_id);
      if (!c.share_numbers) throw new HttpError(403, 'not_allowed', 'the user has not allowed numbers to leave connections');
      const pos = fixtures.kalshiPositions().market_positions;
      const out: Numbers = {
        connection_id: c.connection_id,
        balance_cents: fixtures.kalshiBalance().balance,
        positions: pos.map((p) => ({
          market_id: `kalshi:${p.ticker}`,
          side: p.position >= 0 ? 'yes' : 'no',
          count: Math.abs(p.position),
          avg_price_cents: Math.round(p.total_traded / Math.max(1, Math.abs(p.position))),
        })),
        as_of: now(),
      };
      return out;
    },
  };
}
