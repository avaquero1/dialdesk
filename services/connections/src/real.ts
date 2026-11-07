import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { CONNECTIONS, QUEUES, TRUST_ACTIONS, newId, type Connection, type Numbers } from '@app/contracts';
import {
  busFromConfig,
  createLogger,
  createQueue,
  createWorker,
  HttpError,
  logEntry,
  NoRetry,
  now,
  type Bus,
  type Handlers,
  type Logger,
} from '@app/service-kit';
import { checkScopes, KalshiError, kalshiClient, keyFingerprint, KeyFormatError, parsePrivateKey, type KalshiEnv } from './kalshi.ts';
import { kalshiPositions, polymarketPositions } from './numbers.ts';
import { polymarketClient, PolymarketError } from './polymarket.ts';
import { open, sealAad, SealError } from './seal.ts';
import { MemoryStore, PgStore, type ConnStore, type Row } from './store.ts';
import { openVault, readMasterKey, type Vault } from './vault.ts';

/** connections' own config (CONNECTIONS_*), on top of the template's. */
export const ConnectionsConfig = z.object({
  /** 32 random bytes, base64. Only this container mounts it. Dev: `make dev-secrets` writes deploy/.dev/connections-master.key. */
  MASTER_KEY_FILE: z.string().default('/run/secrets/connections-master'),
  /** Which Kalshi exchanges a key may be connected on. Public demo default: `demo` only, so no real key reaches the public link. */
  KALSHI_ENVS: z.string().default('demo'),
  /** How often shared connections are re-read through `account-refresh` jobs. */
  REFRESH_EVERY_S: z.coerce.number().int().min(30).default(300),
  TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  DATABASE_URL: z.string().optional(),
  VALKEY_URL: z.string().optional(),
});

export interface RealDeps {
  store?: ConnStore;
  /** The raw fetch under the GET-only guard (tests pass recorded answers). */
  fetch?: typeof fetch;
  /** null = no audit entries (tests); default: the ValkeyBus on VALKEY_URL. */
  bus?: Bus | null;
  /** The refresh queue. null = no queue and no schedule (tests); default: BullMQ on VALKEY_URL, or in process without one. */
  enqueueRefresh?: ((connection_id: string, account_id: string) => Promise<void>) | null;
  /** The master key bytes (tests); default: read from MASTER_KEY_FILE. */
  master?: Buffer;
  log?: Logger;
}

const REFUSALS = {
  write_scope: 'This key can trade. Make a read-only key on Kalshi (Account, API keys, scope "read") and paste that one.',
  unknown_scope: 'This key has a scope we do not know to be read-only. Make a key with only the "read" scope.',
  no_scope: 'This key has no scopes. Make a key with the "read" scope.',
  key_not_listed: 'Kalshi did not list this key id for this key. Check the key id you pasted.',
  key_type_mismatch: 'Kalshi says this key is a different type than the one you picked.',
} as const;

/** The real connections: the vault, the read-scope check, and GET-only reads of balances and positions. */
export async function createConnections(cfg: Record<string, unknown> = {}, deps: RealDeps = {}) {
  // a blank variable means its default
  const c = ConnectionsConfig.passthrough().parse(Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== '')));
  const log = deps.log ?? createLogger('connections');
  const envs = new Set(c.KALSHI_ENVS.split(',').map((s) => s.trim()).filter(Boolean));
  for (const e of envs) if (e !== 'demo' && e !== 'prod') throw new Error(`connections: KALSHI_ENVS has ${e}; use demo and/or prod`);

  // No master key, no service: it fails closed at start instead of storing anything it can't encrypt.
  const fromFile = () => {
    const m = readMasterKey(c.MASTER_KEY_FILE);
    if (m.looseMode) log.warn({ file: c.MASTER_KEY_FILE }, 'the master key file is readable by group or others');
    return m.key;
  };
  const master: Buffer = deps.master ? Buffer.from(deps.master) : fromFile();
  const vault: Vault = await openVault(master);
  master.fill(0);

  let store = deps.store;
  if (!store) {
    if (c.DATABASE_URL) store = new PgStore(c.DATABASE_URL);
    else {
      log.warn('no DATABASE_URL: connections are kept in memory and lost on restart');
      store = new MemoryStore();
    }
  }
  const db = store;
  const bus = deps.bus === undefined ? (c.VALKEY_URL ? busFromConfig('connections', c) : null) : deps.bus;
  if (!bus && deps.bus === undefined) log.warn('no VALKEY_URL: audit entries are not written');
  // Ids, hashes and sizes only: never a key, a PEM, a sealed body or an exchange answer. The trust page reads
  // TRUST_ACTIONS rows: an ok connection.scope_checked (subject = the connection, ids.exchange, ids.scope) is a connected
  // account until its connection.removed; consent.* rows are the consents the user gave.
  const scopeIds = (scopes: string[]) => ({ scope: scopes.join(',').slice(0, 40) });
  const audit = async (...a: Parameters<typeof logEntry>) => {
    if (!bus) return;
    await bus.log(logEntry(...a)).catch((e: Error) => log.error({ err: e.message }, 'audit log failed'));
  };

  const poly = polymarketClient({ fetch: deps.fetch, timeoutMs: c.TIMEOUT_MS });
  const kalshiFor = (env: KalshiEnv, keyId: string, key: KeyObject) => kalshiClient({ env, keyId, key, fetch: deps.fetch, timeoutMs: c.TIMEOUT_MS });
  const openKey = (r: Row) => parsePrivateKey(vault.decrypt(r.key_blob!, r.conn.connection_id), r.key_type!);

  /** Read one connection's numbers now and keep them. null when it is gone or not shared. Exchange errors are thrown. */
  const refresh = async (connection_id: string, signal?: AbortSignal): Promise<Numbers | null> => {
    const r = await db.get(connection_id);
    if (!r || !r.conn.share_numbers) return null;
    let n: Numbers;
    if (r.conn.exchange === 'kalshi') {
      const k = kalshiFor(r.env!, r.key_id!, openKey(r));
      const [bal, pos] = await Promise.all([k.balance(signal), k.positions(signal)]);
      n = { connection_id, balance_cents: bal.balance, positions: kalshiPositions(pos), as_of: now() };
    } else {
      n = { connection_id, balance_cents: null, positions: polymarketPositions(await poly.positions(r.wallet!, signal)), as_of: now() };
    }
    await db.putNumbers(n);
    await audit('connections', 'connection.refreshed', {
      account_id: r.conn.account_id,
      subject_id: connection_id,
      outcome: 'ok',
      ids: { exchange: r.conn.exchange },
      sizes: { positions: n.positions.length },
    });
    return n;
  };

  /** The account-refresh job: exchange errors that won't fix themselves fail now; 429 and 5xx retry per QUEUE_RULES. */
  const refreshJob = async (connection_id: string, signal?: AbortSignal) => {
    try {
      await refresh(connection_id, signal);
    } catch (e) {
      if (e instanceof KalshiError && e.kind !== 'retryable') throw new NoRetry(`kalshi_${e.status}`);
      if (e instanceof PolymarketError && !e.retryable) throw new NoRetry(`polymarket_${e.status}`);
      if (e instanceof z.ZodError || e instanceof KeyFormatError) throw new NoRetry('bad_answer');
      throw e;
    }
  };

  let enqueue = deps.enqueueRefresh;
  const closers: (() => Promise<void>)[] = [];
  if (enqueue === undefined) {
    if (c.VALKEY_URL) {
      const q = createQueue(QUEUES.accountRefresh, c.VALKEY_URL, 'connections');
      const w = createWorker(QUEUES.accountRefresh, c.VALKEY_URL, 'connections', (job, { signal }) => refreshJob(job.connection_id, signal));
      // One job per connection per refresh window. No ':' in the id (BullMQ allows it only with exactly 3 parts).
      enqueue = async (connection_id, account_id) => {
        const win = Math.floor(Date.now() / 1000 / c.REFRESH_EVERY_S) * c.REFRESH_EVERY_S;
        await q.enqueue({ job_id: `${connection_id}-${win}`, connection_id, account_id });
      };
      closers.push(
        () => w.close(),
        () => q.close(),
      );
    } else {
      log.warn('no VALKEY_URL: account refresh runs in process');
      enqueue = async (connection_id) => {
        void refreshJob(connection_id).catch((e: Error) => log.warn({ connection_id, err: e.name }, 'refresh failed'));
      };
    }
    const queueRefresh = enqueue;
    const tick = async () => {
      for (const s of await db.shared()) await queueRefresh(s.connection_id, s.account_id);
    };
    const timer = setInterval(() => void tick().catch((e: Error) => log.error({ err: e.message }, 'refresh schedule failed')), c.REFRESH_EVERY_S * 1000);
    timer.unref();
    closers.push(async () => clearInterval(timer));
  }

  const mine = async (id: string, account_id: string) => {
    const r = await db.get(id);
    if (!r || r.conn.account_id !== account_id) throw new HttpError(404, 'not_found', 'no such connection');
    return r;
  };

  const handlers: Handlers<typeof CONNECTIONS> = {
    publicKey: () => ({ alg: 'x25519-sealed-box', public_key: vault.seal.publicKeyB64 }),

    connect: async ({ body }) => {
      const connection_id = newId('con');
      if (body.exchange === 'polymarket') {
        const wallet = body.wallet.toLowerCase();
        const conn: Connection = {
          connection_id,
          account_id: body.account_id,
          exchange: 'polymarket',
          label: `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
          scope: 'read',
          // A wallet address is public data with no power to trade: there is no key to check.
          scope_verified: true,
          checked_at: now(),
          share_numbers: false,
          public_data: true,
        };
        await db.insert({ conn, env: null, key_id: null, key_type: null, key_blob: null, key_fingerprint: null, wallet, scopes: [] });
        await audit('connections', TRUST_ACTIONS.connectionChecked, {
          account_id: body.account_id,
          subject_id: connection_id,
          outcome: 'ok',
          ids: { exchange: 'polymarket', scope: 'read', check: 'public_address' },
        });
        return conn;
      }

      const ids = { exchange: 'kalshi', key_id: body.key_id, env: body.env, key_type: body.key_type };
      if (!envs.has(body.env)) {
        await audit('connections', TRUST_ACTIONS.connectionChecked, { account_id: body.account_id, outcome: 'refused', ids: { ...ids, reason: 'env_not_allowed' } });
        throw new HttpError(403, 'env_not_allowed', `This server connects Kalshi ${[...envs].join(' and ')} keys only.`);
      }
      let pem: string;
      try {
        pem = await open(vault.seal, body.sealed_key, sealAad(body.account_id, body.key_id));
      } catch (e) {
        if (e instanceof SealError) throw new HttpError(400, 'bad_seal', 'The key could not be opened. Reload the page and paste it again.');
        throw e;
      }
      let key: KeyObject;
      try {
        key = parsePrivateKey(pem, body.key_type);
      } catch (e) {
        if (e instanceof KeyFormatError) throw new HttpError(422, 'bad_key', e.message);
        throw e;
      }
      const fingerprint = keyFingerprint(key);

      // D1: read the key's own scopes. Never a write, not even a test order: on a full-access key it would be real.
      let keys;
      try {
        keys = await kalshiFor(body.env, body.key_id, key).apiKeys();
      } catch (e) {
        const reason = e instanceof KalshiError ? `kalshi_${e.status}` : e instanceof z.ZodError ? 'bad_answer' : 'unreachable';
        await audit('connections', TRUST_ACTIONS.connectionChecked, { account_id: body.account_id, outcome: 'failed', ids: { ...ids, reason }, hashes: { key: fingerprint } });
        if (e instanceof KalshiError && e.kind === 'auth') throw new HttpError(422, 'key_rejected', 'Kalshi did not accept this key and key id.');
        log.warn({ reason }, 'scope check failed');
        throw new HttpError(422, 'scope_not_verified', 'Kalshi could not be asked about this key right now. Nothing was saved. Try again.');
      }
      const v = checkScopes(keys, body.key_id, body.key_type);
      if (!v.ok) {
        await audit('connections', TRUST_ACTIONS.connectionChecked, {
          account_id: body.account_id,
          outcome: 'refused',
          ids: { ...ids, ...scopeIds(v.scopes), reason: v.reason },
          hashes: { key: fingerprint },
        });
        throw new HttpError(v.reason === 'write_scope' || v.reason === 'unknown_scope' ? 403 : 422, v.reason, REFUSALS[v.reason]);
      }

      const conn: Connection = {
        connection_id,
        account_id: body.account_id,
        exchange: 'kalshi',
        label: body.key_id.slice(0, 60),
        scope: 'read',
        scope_verified: true,
        checked_at: now(),
        share_numbers: false,
        public_data: false,
      };
      await db.insert({
        conn,
        env: body.env,
        key_id: body.key_id,
        key_type: body.key_type,
        key_blob: vault.encrypt(pem, connection_id),
        key_fingerprint: fingerprint,
        wallet: null,
        scopes: v.scopes,
      });
      await audit('connections', TRUST_ACTIONS.connectionChecked, {
        account_id: body.account_id,
        subject_id: connection_id,
        outcome: 'ok',
        ids: { ...ids, ...scopeIds(v.scopes) },
        hashes: { key: fingerprint },
      });
      return conn;
    },

    list: async ({ query }) => ({ connections: (await db.byAccount(query.account_id)).map((r) => r.conn) }),

    setConsent: async ({ params, body }) => {
      const r = await mine(params.connection_id, body.account_id);
      await db.setConsent(r.conn.connection_id, body.share_numbers);
      await audit('connections', `${TRUST_ACTIONS.consentPrefix}${body.share_numbers ? 'numbers_shared' : 'numbers_withdrawn'}`, {
        account_id: body.account_id,
        subject_id: r.conn.connection_id,
        outcome: 'ok',
        ids: { exchange: r.conn.exchange },
      });
      if (body.share_numbers) await enqueue?.(r.conn.connection_id, body.account_id);
      return { ...r.conn, share_numbers: body.share_numbers };
    },

    remove: async ({ params, query }) => {
      const r = await mine(params.connection_id, query.account_id);
      await db.remove(r.conn.connection_id);
      await audit('connections', TRUST_ACTIONS.connectionRemoved, { account_id: query.account_id, subject_id: r.conn.connection_id, outcome: 'ok', ids: { exchange: r.conn.exchange } });
      return { ok: true };
    },

    numbers: async ({ params, query }) => {
      const r = await mine(params.connection_id, query.account_id);
      if (!r.conn.share_numbers) throw new HttpError(403, 'not_allowed', 'the user has not allowed numbers to leave connections');
      const n = (await db.numbers(r.conn.connection_id)) ?? (await refresh(r.conn.connection_id));
      // null only when consent was withdrawn in between
      if (!n) throw new HttpError(403, 'not_allowed', 'the user has not allowed numbers to leave connections');
      return n;
    },
  };

  return {
    handlers,
    /** Read one connection now (tests; the worker uses it through refreshJob). */
    refresh,
    refreshJob,
    async close() {
      for (const f of closers) await f();
      await db.end();
    },
  };
}

/** For `runService`: the handlers only. */
export async function real(cfg: Record<string, unknown> = {}, deps: RealDeps = {}): Promise<Handlers<typeof CONNECTIONS>> {
  return (await createConnections(cfg, deps)).handlers;
}
