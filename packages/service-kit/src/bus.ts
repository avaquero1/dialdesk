import { ACCOUNTS, EVENTS, LogEntry, type EventName, type EventPayload, type ServiceName } from '@app/contracts';
import type { Call } from './client.ts';
import type { Logger } from './log.ts';

/**
 * Events and the log stream, as an interface. Fakes and tests use MemoryBus; real mode uses ValkeyBus
 * (valkey.ts: pub/sub on `events.<name>`, XADD to LOG_STREAM), from `busFromConfig`. Both validate before sending.
 */
export interface Bus {
  emit<E extends EventName>(event: E, payload: EventPayload<E>): Promise<void>;
  log(entry: LogEntry): Promise<void>;
}

type OnEvent = <E extends EventName>(event: E, payload: EventPayload<E>) => void;

/** A bus that can listen: ValkeyBus, and MemoryBus in process (one MemoryBus shared by several services in a test). */
export interface Subscriber {
  subscribe(events: EventName[] | 'all', onEvent: OnEvent): Promise<() => Promise<void>>;
}

export class MemoryBus implements Bus, Subscriber {
  readonly events: { event: EventName; payload: unknown }[] = [];
  readonly entries: LogEntry[] = [];
  private readonly listeners = new Set<{ events: EventName[] | 'all'; onEvent: OnEvent }>();
  async emit<E extends EventName>(event: E, payload: EventPayload<E>) {
    const body = EVENTS[event].schema.parse(payload) as EventPayload<E>;
    this.events.push({ event, payload: body });
    for (const l of this.listeners) if (l.events === 'all' || l.events.includes(event)) l.onEvent(event, structuredClone(body));
  }
  async subscribe(events: EventName[] | 'all', onEvent: OnEvent) {
    const l = { events, onEvent };
    this.listeners.add(l);
    return async () => void this.listeners.delete(l);
  }
  async log(entry: LogEntry) {
    this.entries.push(LogEntry.parse(entry));
  }
}

export function logEntry(service: LogEntry['service'], action: string, rest: Partial<LogEntry> = {}): LogEntry {
  return {
    service,
    action,
    at: new Date().toISOString(),
    account_id: null,
    subject_id: null,
    outcome: null,
    ids: {},
    hashes: {},
    sizes: {},
    ...rest,
  };
}

/** A service's own rows per account, for account deletion. Only its own tables. */
export interface AccountData {
  /** Every account id that has rows here (the orphan sweep checks them with accounts). */
  accountIds(): Promise<string[]>;
  /** Deletes the account's rows; answers how many top-level rows went (boards, conversations, connections…). */
  forget(account_id: string): Promise<number>;
}

export interface FollowOptions {
  service: Extract<ServiceName, 'board' | 'agent' | 'connections'>;
  bus: Bus & Subscriber;
  data: AccountData;
  /** accounts, for ACCOUNTS.missing. Without it there is no orphan sweep (the event alone). */
  accounts?: Call;
  log: Logger;
  /** The orphan sweep's period; it also runs `firstSweepMs` after start. 0 turns the timer off (tests call sweepOrphans). */
  everyMs?: number;
  firstSweepMs?: number;
}

/**
 * Deleted accounts, followed by one service: on account.deleted it deletes that account's rows. Pub/sub drops an
 * event while the service is down, so an orphan sweep (at start, then every 6 hours) asks accounts which of the ids
 * it holds are gone and deletes those too. Only a definite answer from accounts deletes anything: an error leaves the
 * rows for the next sweep. Each deletion is one `account.data_deleted` row in the log (ids and sizes only).
 */
export async function followAccountDeletes(o: FollowOptions) {
  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>) => {
    pending.add(p);
    void p.finally(() => pending.delete(p)).catch(() => {});
    return p;
  };
  const forget = async (account_id: string, reason: 'account_deleted' | 'orphan') => {
    const rows = await o.data.forget(account_id);
    await o.bus.log(logEntry(o.service, 'account.data_deleted', { account_id, subject_id: account_id, outcome: 'ok', ids: { reason }, sizes: { rows } }));
    return rows;
  };
  const unsubscribe = await o.bus.subscribe(['account.deleted'], (_e, p) => {
    const { account_id } = p as EventPayload<'account.deleted'>;
    void track(forget(account_id, 'account_deleted')).catch((err) => o.log.error({ err: (err as Error).message, account_id }, 'account delete failed'));
  });

  /** Deletes the rows of every account accounts says is gone. Answers how many accounts. */
  const sweepOrphans = async () => {
    if (!o.accounts) return 0;
    const ids = [...new Set(await o.data.accountIds())];
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const { missing } = await o.accounts(ACCOUNTS.missing, { body: { account_ids: ids.slice(i, i + 500) as never } });
      for (const id of missing) {
        await forget(id, 'orphan');
        n++;
      }
    }
    if (n) o.log.info({ accounts: n }, 'orphan sweep');
    return n;
  };
  const run = () => void track(sweepOrphans()).catch((err) => o.log.warn({ err: (err as Error).message }, 'orphan sweep failed; next time'));
  const every = o.everyMs ?? 6 * 3600_000;
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (every > 0 && o.accounts) {
    timers.push(setTimeout(run, o.firstSweepMs ?? 60_000), setInterval(run, every));
    for (const t of timers) t.unref();
  }
  return {
    sweepOrphans,
    /** Resolves when every delete started so far has finished (tests). */
    idle: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    stop: async () => {
      for (const t of timers) clearTimeout(t);
      await unsubscribe();
    },
  };
}
