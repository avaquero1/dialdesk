import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { z } from 'zod';
import { ACCOUNTS, DEFAULT_LOOK, Look, newId, type Account } from '@app/contracts';
import { HttpError, MemoryBus, createLogger, logEntry, now, type Bus, type Handlers, type Logger } from '@app/service-kit';
import { DEFAULT_COST, dummyHash, hashPassword, verifyPassword, type Argon2Cost } from './password.ts';
import { loadSigningKey, signSession, type SigningKey } from './session.ts';
import { memoryStore, pgStore, type AccountRow, type Store } from './store.ts';

export interface AccountsOptions {
  store: Store;
  key: SigningKey;
  bus?: Bus;
  cost?: Argon2Cost;
  /** Seconds. */
  sessionTtl?: number;
  guestTtl?: number;
  /** Guests created per hour, all callers together (edge also limits per address). */
  guestsPerHour?: number;
  /** Failed logins per email per 15 minutes before 429. */
  loginFailures?: number;
  clock?: () => number;
}

const DAY = 86400;
const strip = ({ password_hash: _p, ...a }: AccountRow): Account => a;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Emails are compared lower-case, so Kim@x and kim@x are one account. */
const normalize = (email: string) => email.trim().toLowerCase();

/** The real accounts on any store. `real(cfg)` below wires it from env. */
export function createAccounts(o: AccountsOptions): Handlers<typeof ACCOUNTS> {
  const { store, key } = o;
  const bus = o.bus ?? new MemoryBus();
  const cost = o.cost ?? DEFAULT_COST;
  const clock = o.clock ?? Date.now;
  const sessionTtl = o.sessionTtl ?? 7 * DAY;
  const guestTtl = o.guestTtl ?? DAY;
  let dummy: Promise<string> | null = null;

  // Two small windows in memory (one accounts instance): guest creation overall, failed logins per email.
  const guestTimes: number[] = [];
  const failures = new Map<string, number[]>();
  const recent = (xs: number[], windowMs: number) => {
    const cut = clock() - windowMs;
    while (xs.length && xs[0]! < cut) xs.shift();
    return xs;
  };

  async function startSession(a: AccountRow) {
    const iat = Math.floor(clock() / 1000);
    const exp = iat + (a.guest ? guestTtl : sessionTtl);
    const session_id = newId('ses');
    const expires_at = new Date(exp * 1000).toISOString();
    await store.insertSession({ session_id, account_id: a.account_id, expires_at, revoked: false });
    const token = signSession({ sub: a.account_id, sid: session_id, plan: a.plan, guest: a.guest, iat, exp }, key);
    await bus.log(logEntry('accounts', 'session.created', { account_id: a.account_id, subject_id: session_id, outcome: 'ok' }));
    return { account: strip(a), session: { session_id, token, expires_at } };
  }

  const newAccount = (email: string | null, password_hash: string | null): AccountRow => ({
    account_id: newId('acc'),
    email,
    password_hash,
    plan: 'free',
    guest: email === null,
    look: { ...DEFAULT_LOOK },
    created_at: new Date(clock()).toISOString(),
  });

  return {
    signup: async ({ body }) => {
      const email = normalize(body.email);
      const a = newAccount(email, await hashPassword(body.password, cost));
      if (!(await store.insertAccount(a))) throw new HttpError(409, 'exists', 'that email has an account');
      await bus.log(logEntry('accounts', 'account.created', { account_id: a.account_id, subject_id: a.account_id, outcome: 'ok', hashes: { email: sha256(email) } }));
      return startSession(a);
    },

    guest: async () => {
      const times = recent(guestTimes, 3600_000);
      if (times.length >= (o.guestsPerHour ?? 500)) throw new HttpError(429, 'busy', 'too many guests this hour; try again later');
      times.push(clock());
      const a = newAccount(null, null);
      await store.insertAccount(a);
      await bus.log(logEntry('accounts', 'account.guest_created', { account_id: a.account_id, subject_id: a.account_id, outcome: 'ok' }));
      return startSession(a);
    },

    login: async ({ body }) => {
      const email = normalize(body.email);
      const tag = sha256(email);
      const fails = recent(failures.get(tag) ?? [], 15 * 60_000);
      if (fails.length >= (o.loginFailures ?? 10)) throw new HttpError(429, 'locked', 'too many failed logins; try again in 15 minutes');
      const a = await store.accountByEmail(email);
      // Always run argon2, so an unknown email costs the same time as a wrong password.
      const ok = await verifyPassword(body.password, a?.password_hash ?? (await (dummy ??= dummyHash(cost))));
      if (!a || !ok) {
        fails.push(clock());
        failures.set(tag, fails);
        if (failures.size > 100_000) failures.clear();
        await bus.log(logEntry('accounts', 'login.failed', { outcome: 'refused', hashes: { email: tag } }));
        throw new HttpError(401, 'bad_login', 'wrong email or password');
      }
      failures.delete(tag);
      return startSession(a);
    },

    logout: async ({ params }) => {
      if (!(await store.revokeSession(params.session_id))) throw new HttpError(404, 'not_found', 'no such session');
      await bus.log(logEntry('accounts', 'session.revoked', { subject_id: params.session_id, outcome: 'ok' }));
      return { ok: true };
    },

    sessionValid: async ({ params }) => {
      const s = await store.session(params.session_id);
      return { session_id: params.session_id, valid: !!s && !s.revoked && Date.parse(s.expires_at) > clock() };
    },

    get: async ({ params }) => {
      const a = await store.accountById(params.account_id);
      if (!a) throw new HttpError(404, 'not_found', 'no such account');
      return strip(a);
    },

    setLook: async ({ params, body }) => {
      // The template already checked the body against Look; check again here, at the store's door.
      const look = Look.safeParse(body);
      if (!look.success) throw new HttpError(400, 'bad_look', 'not a valid look');
      if (!(await store.setLook(params.account_id, look.data))) throw new HttpError(404, 'not_found', 'no such account');
      await bus.emit('look.changed', { account_id: params.account_id, at: now(), look: look.data });
      await bus.log(logEntry('accounts', 'look.changed', { account_id: params.account_id, subject_id: params.account_id, outcome: 'ok' }));
      return look.data;
    },
  };
}

/**
 * "Try it" guests are deleted nightly: once a day at `hourUtc` (default 08:00 UTC, 3 AM in New York) every guest
 * created more than an hour earlier goes, with its sessions. `tick` is exported for tests.
 */
export function scheduleGuestSweep(store: Store, log: Logger, bus: Bus, hourUtc = 8, clock: () => number = Date.now) {
  let lastDay = '';
  const tick = async () => {
    const d = new Date(clock());
    const day = d.toISOString().slice(0, 10);
    if (d.getUTCHours() !== hourUtc || day === lastDay) return null;
    lastDay = day;
    try {
      const n = await store.deleteGuests(new Date(clock() - 3600_000).toISOString());
      log.info({ deleted: n }, 'guest sweep');
      await bus.log(logEntry('accounts', 'account.guests_swept', { outcome: 'ok', sizes: { accounts: n } }));
      return n;
    } catch (err) {
      log.error({ err: (err as Error).message }, 'guest sweep failed');
      return null;
    }
  };
  const timer = setInterval(() => void tick(), 5 * 60_000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

const RealConfig = z.object({
  SESSION_KEY_FILE: z.string({ error: 'set ACCOUNTS_SESSION_KEY_FILE to the Ed25519 private key (make dev-secrets writes one)' }).min(1),
  DATABASE_URL: z.string().optional(),
  GUEST_SWEEP_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(8),
});

/** The real accounts from env: Postgres (ACCOUNTS_DATABASE_URL) and the key file (ACCOUNTS_SESSION_KEY_FILE). */
export function real(cfg: Record<string, unknown> = {}): Handlers<typeof ACCOUNTS> {
  const c = RealConfig.parse(cfg);
  const log = createLogger('accounts');
  const key = loadSigningKey(c.SESSION_KEY_FILE);
  // Pool max 3 per service (architecture: Postgres). Without a database (never in production) it runs in memory.
  const store = c.DATABASE_URL ? pgStore(postgres(c.DATABASE_URL, { max: 3, onnotice: () => {} })) : memoryStore();
  if (!c.DATABASE_URL) log.warn('no ACCOUNTS_DATABASE_URL: accounts are in memory and vanish on restart');
  // MemoryBus until service-kit's ValkeyBus lands: look.changed and the log stay in this process.
  const bus = new MemoryBus();
  scheduleGuestSweep(store, log, bus, c.GUEST_SWEEP_HOUR_UTC);
  log.info({ kid: key.kid }, 'session signing key loaded');
  return createAccounts({ store, key, bus });
}
