import { Look, type Account } from '@app/contracts';
import type postgres from 'postgres';

/** A stored account: the contract's Account plus the password hash, which never leaves accounts. */
export type AccountRow = Account & { password_hash: string | null };
export interface SessionRow {
  session_id: string;
  account_id: string;
  expires_at: string;
  revoked: boolean;
}

/** accounts' storage. Postgres in production; the memory store backs the real-mode tests in `make check`. */
export interface Store {
  /** Returns false when the email is taken (the unique index decides, not a read first). */
  insertAccount(a: AccountRow): Promise<boolean>;
  accountById(id: string): Promise<AccountRow | null>;
  accountByEmail(email: string): Promise<AccountRow | null>;
  setLook(id: string, look: Look): Promise<boolean>;
  insertSession(s: SessionRow): Promise<void>;
  session(id: string): Promise<SessionRow | null>;
  revokeSession(id: string): Promise<boolean>;
  /** Deletes guests made before `before` and their sessions; answers the deleted account ids. */
  deleteGuests(before: string): Promise<string[]>;
  /** Which of these ids are accounts. */
  existing(ids: string[]): Promise<string[]>;
}

export function memoryStore(): Store {
  const accounts = new Map<string, AccountRow>();
  const sessions = new Map<string, SessionRow>();
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    async insertAccount(a) {
      if (a.email !== null && [...accounts.values()].some((x) => x.email === a.email)) return false;
      accounts.set(a.account_id, clone(a));
      return true;
    },
    async accountById(id) {
      const a = accounts.get(id);
      return a ? clone(a) : null;
    },
    async accountByEmail(email) {
      const a = [...accounts.values()].find((x) => x.email === email);
      return a ? clone(a) : null;
    },
    async setLook(id, look) {
      const a = accounts.get(id);
      if (!a) return false;
      a.look = clone(look);
      return true;
    },
    async insertSession(s) {
      sessions.set(s.session_id, clone(s));
    },
    async session(id) {
      const s = sessions.get(id);
      return s ? clone(s) : null;
    },
    async revokeSession(id) {
      const s = sessions.get(id);
      if (!s) return false;
      s.revoked = true;
      return true;
    },
    async deleteGuests(before) {
      const gone: string[] = [];
      for (const a of [...accounts.values()])
        if (a.guest && a.created_at < before) {
          accounts.delete(a.account_id);
          for (const s of [...sessions.values()]) if (s.account_id === a.account_id) sessions.delete(s.session_id);
          gone.push(a.account_id);
        }
      return gone;
    },
    async existing(ids) {
      return ids.filter((id) => accounts.has(id));
    },
  };
}

type Sql = ReturnType<typeof postgres>;
type Row = {
  account_id: string;
  email: string | null;
  password_hash: string | null;
  plan: 'free' | 'pro';
  guest: boolean;
  look: unknown;
  created_at: Date;
};

/** Tables from migrations/0002_accounts.sql, in schema "accounts" (the role's search_path). */
export function pgStore(sql: Sql): Store {
  const toAccount = (r: Row): AccountRow => ({
    account_id: r.account_id,
    email: r.email,
    password_hash: r.password_hash,
    plan: r.plan,
    guest: r.guest,
    // Written only after validation; read back through the schema too, so a bad row can't reach a browser.
    look: Look.parse(r.look),
    created_at: r.created_at.toISOString(),
  });
  return {
    async insertAccount(a) {
      const rows = await sql`
        insert into accounts (account_id, email, password_hash, plan, guest, look, created_at)
        values (${a.account_id}, ${a.email}, ${a.password_hash}, ${a.plan}, ${a.guest}, ${sql.json(a.look)}, ${a.created_at})
        on conflict (email) do nothing
        returning account_id`;
      return rows.length === 1;
    },
    async accountById(id) {
      const [r] = await sql<Row[]>`select * from accounts where account_id = ${id}`;
      return r ? toAccount(r) : null;
    },
    async accountByEmail(email) {
      const [r] = await sql<Row[]>`select * from accounts where email = ${email}`;
      return r ? toAccount(r) : null;
    },
    async setLook(id, look) {
      const rows = await sql`update accounts set look = ${sql.json(Look.parse(look))} where account_id = ${id} returning account_id`;
      return rows.length === 1;
    },
    async insertSession(s) {
      await sql`insert into sessions (session_id, account_id, expires_at) values (${s.session_id}, ${s.account_id}, ${s.expires_at})`;
    },
    async session(id) {
      const [r] = await sql<{ session_id: string; account_id: string; expires_at: Date; revoked_at: Date | null }[]>`
        select session_id, account_id, expires_at, revoked_at from sessions where session_id = ${id}`;
      return r ? { session_id: r.session_id, account_id: r.account_id, expires_at: r.expires_at.toISOString(), revoked: r.revoked_at !== null } : null;
    },
    async revokeSession(id) {
      const rows = await sql`update sessions set revoked_at = coalesce(revoked_at, now()) where session_id = ${id} returning session_id`;
      return rows.length === 1;
    },
    async deleteGuests(before) {
      const rows = await sql<{ account_id: string }[]>`delete from accounts where guest and created_at < ${before} returning account_id`;
      return rows.map((r) => r.account_id);
    },
    async existing(ids) {
      const rows = await sql<{ account_id: string }[]>`select account_id from accounts where account_id = any(${ids})`;
      return rows.map((r) => r.account_id);
    },
  };
}
