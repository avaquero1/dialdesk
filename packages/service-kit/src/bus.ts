import { EVENTS, LogEntry, type EventName, type EventPayload } from '@app/contracts';

/**
 * Events and the log stream, as an interface. Fakes and tests use MemoryBus; real mode uses ValkeyBus
 * (valkey.ts: pub/sub on `events.<name>`, XADD to LOG_STREAM), from `busFromConfig`. Both validate before sending.
 */
export interface Bus {
  emit<E extends EventName>(event: E, payload: EventPayload<E>): Promise<void>;
  log(entry: LogEntry): Promise<void>;
}

export class MemoryBus implements Bus {
  readonly events: { event: EventName; payload: unknown }[] = [];
  readonly entries: LogEntry[] = [];
  async emit<E extends EventName>(event: E, payload: EventPayload<E>) {
    this.events.push({ event, payload: EVENTS[event].schema.parse(payload) });
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
