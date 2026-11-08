import postgres from 'postgres';
import { ModelRole } from '@app/contracts';

const MODEL_ROLES = ModelRole.options;

/**
 * Metering, caps and the kill switch.
 * - Every call is metered per day (UTC), account, role and model: calls, tokens, cost.
 * - Before a call, its worst case (estimated input + max_tokens) is reserved against three caps: the account's daily
 *   tokens, the account's daily USD, and the global daily USD. A call that could cross one is refused, so the meter
 *   never spends past a cap, even with calls in flight. After the call the reservation is settled with the real usage.
 * - The kill switch: the first time the day's global budget can't cover a call's worst case (or MODELS_KILL=1), it
 *   trips, and every call is refused until the next UTC day.
 */
export interface Caps {
  daily_usd: number;
  account_daily_usd: number;
  account_daily_tokens: number;
  /** Calls per account per minute. */
  account_rpm: number;
  /** MODELS_KILL=1: refuse everything now. */
  kill: boolean;
}

export const DEFAULT_CAPS: Caps = { daily_usd: 5, account_daily_usd: 0.25, account_daily_tokens: 2_000_000, account_rpm: 30, kill: false };

export interface UsageRow {
  day: string;
  account: string; // an account id, or 'system' for calls with account_id null
  role: ModelRole;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface UsageStore {
  load(day: string): Promise<UsageRow[]>;
  add(row: UsageRow): Promise<void>;
}

export class MemoryUsageStore implements UsageStore {
  readonly rows = new Map<string, UsageRow>();
  async load(day: string) {
    return [...this.rows.values()].filter((r) => r.day === day).map((r) => ({ ...r }));
  }
  async add(r: UsageRow) {
    const k = `${r.day}|${r.account}|${r.role}|${r.model}`;
    const cur = this.rows.get(k);
    if (!cur) this.rows.set(k, { ...r });
    else {
      cur.calls += r.calls;
      cur.input_tokens += r.input_tokens;
      cur.output_tokens += r.output_tokens;
      cur.cost_usd += r.cost_usd;
    }
  }
}

/** models.usage (migrations/0002_usage.sql), through the svc_models role. */
export class PgUsageStore implements UsageStore {
  private sql: postgres.Sql;
  constructor(databaseUrl: string, schema = 'models') {
    this.sql = postgres(databaseUrl, { max: 2, onnotice: () => {}, connection: { search_path: schema } });
  }
  async load(day: string) {
    const rows = await this.sql<UsageRow[]>`
      select day::text as day, account, role, model, calls, input_tokens::int as input_tokens, output_tokens::int as output_tokens,
             cost_usd::float8 as cost_usd
      from usage where day = ${day}`;
    return rows.map((r) => ({ ...r }));
  }
  async add(r: UsageRow) {
    await this.sql`
      insert into usage (day, account, role, model, calls, input_tokens, output_tokens, cost_usd)
      values (${r.day}, ${r.account}, ${r.role}, ${r.model}, ${r.calls}, ${r.input_tokens}, ${r.output_tokens}, ${r.cost_usd})
      on conflict (day, account, role, model) do update set
        calls = usage.calls + excluded.calls,
        input_tokens = usage.input_tokens + excluded.input_tokens,
        output_tokens = usage.output_tokens + excluded.output_tokens,
        cost_usd = usage.cost_usd + excluded.cost_usd`;
  }
  async end() {
    await this.sql.end();
  }
}

export type CapRefusal = 'kill_switch' | 'account_usd_cap' | 'account_token_cap' | 'rate_limited';

export class CapError extends Error {
  constructor(readonly reason: CapRefusal) {
    super(reason);
  }
}

export interface Reservation {
  account: string;
  usd: number;
  tokens: number;
  done: boolean;
}

type Totals = { usd: number; tokens: number; by_role: Record<ModelRole, number> };
const emptyTotals = (): Totals => ({ usd: 0, tokens: 0, by_role: Object.fromEntries(MODEL_ROLES.map((r) => [r, 0])) as Record<ModelRole, number> });

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export class Meter {
  private day = '';
  private global = emptyTotals();
  private accounts = new Map<string, Totals>();
  private reservedGlobal = 0;
  private reservedAccount = new Map<string, { usd: number; tokens: number }>();
  private recent = new Map<string, number[]>();
  private tripped = false;

  constructor(
    readonly caps: Caps,
    private store: UsageStore,
    private clock: () => Date = () => new Date(),
  ) {}

  /** Loads today's rows (call once at start; also called on a new UTC day). */
  async open(): Promise<void> {
    await this.rollover();
  }

  private async rollover() {
    const today = utcDay(this.clock());
    if (today === this.day) return;
    this.day = today;
    this.global = emptyTotals();
    this.accounts.clear();
    this.recent.clear();
    this.tripped = false;
    for (const r of await this.store.load(today)) this.count(r);
  }

  private count(r: UsageRow) {
    const t = this.accounts.get(r.account) ?? emptyTotals();
    this.accounts.set(r.account, t);
    for (const x of [this.global, t]) {
      x.usd += r.cost_usd;
      x.tokens += r.input_tokens + r.output_tokens;
      x.by_role[r.role] += r.cost_usd;
    }
  }

  killSwitch(): boolean {
    return this.caps.kill || this.tripped || this.global.usd >= this.caps.daily_usd;
  }

  /** Reserve a call's worst case, or throw CapError. */
  async reserve(accountId: string | null, worst: { usd: number; tokens: number }): Promise<Reservation> {
    await this.rollover();
    const account = accountId ?? 'system';
    if (this.killSwitch()) throw new CapError('kill_switch');
    if (this.global.usd + this.reservedGlobal + worst.usd > this.caps.daily_usd) {
      this.tripped = true;
      throw new CapError('kill_switch');
    }
    if (accountId) {
      const t = this.accounts.get(account) ?? emptyTotals();
      const held = this.reservedAccount.get(account) ?? { usd: 0, tokens: 0 };
      if (t.usd + held.usd + worst.usd > this.caps.account_daily_usd) throw new CapError('account_usd_cap');
      if (t.tokens + held.tokens + worst.tokens > this.caps.account_daily_tokens) throw new CapError('account_token_cap');
      const nowMs = this.clock().getTime();
      const calls = (this.recent.get(account) ?? []).filter((at) => nowMs - at < 60_000);
      if (calls.length >= this.caps.account_rpm) throw new CapError('rate_limited');
      calls.push(nowMs);
      this.recent.set(account, calls);
    }
    this.hold(account, worst.usd, worst.tokens);
    return { account, usd: worst.usd, tokens: worst.tokens, done: false };
  }

  private hold(account: string, usd: number, tokens: number) {
    this.reservedGlobal += usd;
    const held = this.reservedAccount.get(account) ?? { usd: 0, tokens: 0 };
    held.usd += usd;
    held.tokens += tokens;
    this.reservedAccount.set(account, held);
  }

  /** The call failed and nothing was billed. */
  release(r: Reservation) {
    if (r.done) return;
    r.done = true;
    this.hold(r.account, -r.usd, -r.tokens);
  }

  /** The call answered: record what it really used. */
  async settle(r: Reservation, used: { role: ModelRole; model: string; input_tokens: number; output_tokens: number; cost_usd: number }) {
    this.release(r);
    await this.rollover();
    const row: UsageRow = { day: this.day, account: r.account, calls: 1, ...used };
    this.count(row);
    await this.store.add(row);
  }

  async spend(accountId?: string) {
    await this.rollover();
    const t = accountId ? (this.accounts.get(accountId) ?? emptyTotals()) : this.global;
    const cap = accountId ? this.caps.account_daily_usd : this.caps.daily_usd;
    return {
      day: this.day,
      total_usd: round(t.usd),
      by_role: Object.fromEntries(Object.entries(t.by_role).map(([k, v]) => [k, round(v)])) as Record<ModelRole, number>,
      daily_cap_usd: cap,
      remaining_usd: round(Math.max(0, cap - t.usd)),
      kill_switch: this.killSwitch(),
      as_of: this.clock().toISOString(),
    };
  }
}

const round = (n: number) => Math.round(n * 1e8) / 1e8;
