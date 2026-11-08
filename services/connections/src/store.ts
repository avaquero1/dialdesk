import postgres from 'postgres';
import type { Connection, Numbers } from '@app/contracts';

/** One stored connection. `key_blob` is the vault's ciphertext of the PEM; the plain key is never stored. */
export interface Row {
  conn: Connection;
  env: 'prod' | 'demo' | null;
  key_id: string | null;
  key_type: 'ed25519' | 'rsa' | null;
  key_blob: Buffer | null;
  key_fingerprint: string | null;
  wallet: string | null;
  scopes: string[];
}

export interface ConnStore {
  insert(r: Row): Promise<void>;
  get(id: string): Promise<Row | null>;
  byAccount(account_id: string): Promise<Row[]>;
  setConsent(id: string, share: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  /** Connections whose numbers may leave (the refresh schedule reads only these). */
  shared(): Promise<{ connection_id: string; account_id: string }[]>;
  /** Every account with a connection (the orphan sweep). */
  accountIds(): Promise<string[]>;
  putNumbers(n: Numbers): Promise<void>;
  numbers(id: string): Promise<Numbers | null>;
  end(): Promise<void>;
}

export class MemoryStore implements ConnStore {
  private rows = new Map<string, Row>();
  private nums = new Map<string, Numbers>();
  async insert(r: Row) {
    this.rows.set(r.conn.connection_id, structuredClone(r));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }
  async byAccount(a: string) {
    return [...this.rows.values()].filter((r) => r.conn.account_id === a).map((r) => structuredClone(r));
  }
  async setConsent(id: string, share: boolean) {
    const r = this.rows.get(id);
    if (r) r.conn.share_numbers = share;
  }
  async remove(id: string) {
    this.rows.delete(id);
    this.nums.delete(id);
  }
  async shared() {
    return [...this.rows.values()].filter((r) => r.conn.share_numbers).map((r) => ({ connection_id: r.conn.connection_id, account_id: r.conn.account_id }));
  }
  async accountIds() {
    return [...new Set([...this.rows.values()].map((r) => r.conn.account_id))];
  }
  async putNumbers(n: Numbers) {
    if (this.rows.has(n.connection_id)) this.nums.set(n.connection_id, structuredClone(n));
  }
  async numbers(id: string) {
    const n = this.nums.get(id);
    return n ? structuredClone(n) : null;
  }
  async end() {}
}

interface DbRow {
  connection_id: string;
  account_id: string;
  exchange: 'kalshi' | 'polymarket';
  label: string;
  env: 'prod' | 'demo' | null;
  key_id: string | null;
  key_type: 'ed25519' | 'rsa' | null;
  key_blob: Buffer | null;
  key_fingerprint: string | null;
  wallet: string | null;
  scopes: string[];
  scope_verified: boolean;
  checked_at: Date | null;
  share_numbers: boolean;
  public_data: boolean;
}

const fromDb = (d: DbRow): Row => ({
  conn: {
    connection_id: d.connection_id,
    account_id: d.account_id,
    exchange: d.exchange,
    label: d.label,
    scope: 'read',
    scope_verified: d.scope_verified,
    checked_at: d.checked_at ? d.checked_at.toISOString() : null,
    share_numbers: d.share_numbers,
    public_data: d.public_data,
  },
  env: d.env,
  key_id: d.key_id,
  key_type: d.key_type,
  key_blob: d.key_blob,
  key_fingerprint: d.key_fingerprint,
  wallet: d.wallet,
  scopes: d.scopes,
});

export class PgStore implements ConnStore {
  private sql: postgres.Sql;
  constructor(databaseUrl: string, schema = 'connections') {
    this.sql = postgres(databaseUrl, { max: 3, onnotice: () => {}, connection: { search_path: schema } });
  }
  async insert(r: Row) {
    const c = r.conn;
    await this.sql`
      insert into connections (connection_id, account_id, exchange, label, env, key_id, key_type, key_blob, key_fingerprint, wallet,
                               scopes, scope_verified, checked_at, share_numbers, public_data)
      values (${c.connection_id}, ${c.account_id}, ${c.exchange}, ${c.label}, ${r.env}, ${r.key_id}, ${r.key_type}, ${r.key_blob},
              ${r.key_fingerprint}, ${r.wallet}, ${r.scopes}::text[], ${c.scope_verified}, ${c.checked_at}, ${c.share_numbers}, ${c.public_data})`;
  }
  async get(id: string) {
    const [d] = await this.sql<DbRow[]>`select * from connections where connection_id = ${id}`;
    return d ? fromDb(d) : null;
  }
  async byAccount(a: string) {
    return (await this.sql<DbRow[]>`select * from connections where account_id = ${a} order by created_at`).map(fromDb);
  }
  async setConsent(id: string, share: boolean) {
    await this.sql`update connections set share_numbers = ${share} where connection_id = ${id}`;
  }
  async remove(id: string) {
    await this.sql`delete from connections where connection_id = ${id}`;
  }
  async shared() {
    return this.sql<{ connection_id: string; account_id: string }[]>`select connection_id, account_id from connections where share_numbers`;
  }
  async accountIds() {
    return (await this.sql<{ account_id: string }[]>`select distinct account_id from connections`).map((r) => r.account_id);
  }
  async putNumbers(n: Numbers) {
    await this.sql`
      insert into numbers (connection_id, balance_cents, positions, as_of)
      select ${n.connection_id}::text, ${n.balance_cents}::bigint, ${this.sql.json(n.positions)}, ${n.as_of}::timestamptz
      where exists (select 1 from connections where connection_id = ${n.connection_id}::text)
      on conflict (connection_id) do update set balance_cents = excluded.balance_cents, positions = excluded.positions, as_of = excluded.as_of`;
  }
  async numbers(id: string) {
    const [d] = await this.sql<{ balance_cents: string | null; positions: Numbers['positions']; as_of: Date }[]>`
      select balance_cents, positions, as_of from numbers where connection_id = ${id}`;
    if (!d) return null;
    return { connection_id: id, balance_cents: d.balance_cents === null ? null : Number(d.balance_cents), positions: d.positions, as_of: d.as_of.toISOString() };
  }
  async end() {
    await this.sql.end();
  }
}
