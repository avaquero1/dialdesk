import { Redis, type RedisOptions } from 'ioredis';
import {
  EVENTS,
  EVENT_CHANNEL_PREFIX,
  EventName,
  LOG_CONSUMER_GROUP,
  LOG_STREAM,
  LogEntry,
  eventChannel,
  type EventPayload,
} from '@app/contracts';
import type { Bus } from './bus.ts';

/**
 * A Valkey connection as one service's ACL user (`<SVC>_VALKEY_URL` is `redis://svc-<service>:<password>@host:port`).
 * Every connection names itself, so CLIENT LIST shows who is who.
 */
export function valkeyClient(url: string, name: string, opts: RedisOptions = {}): Redis {
  return new Redis(url, { connectionName: name, ...opts });
}

export type EventHandler = <E extends EventName>(event: E, payload: EventPayload<E>) => void;

/**
 * The real Bus: events go out with PUBLISH on `events.<name>`, log entries with XADD to `log:actions` (one field,
 * `entry`, holding the JSON). Both are validated against packages/contracts before they leave, as in MemoryBus.
 * The stream isn't trimmed here: audit reads, acks and trims it, so entries wait while audit is down.
 */
export class ValkeyBus implements Bus {
  private readonly redis: Redis;
  private readonly subs = new Set<Redis>();

  constructor(
    private readonly url: string,
    private readonly name: string,
  ) {
    this.redis = valkeyClient(url, name);
  }

  async emit<E extends EventName>(event: E, payload: EventPayload<E>) {
    const body = EVENTS[event].schema.parse(payload);
    await this.redis.publish(eventChannel(event), JSON.stringify(body));
  }

  async log(entry: LogEntry) {
    await this.redis.xadd(LOG_STREAM, '*', 'entry', JSON.stringify(LogEntry.parse(entry)));
  }

  /**
   * Listen to some events, or `'all'` (edge, with PSUBSCRIBE `events.*`). A payload that fails its schema is dropped
   * and handed to `onInvalid`: events are hints, so nothing waits on them. Returns a function that stops listening.
   */
  async subscribe(events: EventName[] | 'all', onEvent: EventHandler, onInvalid?: (channel: string, error: Error) => void) {
    const sub = valkeyClient(this.url, `${this.name}-sub`);
    this.subs.add(sub);
    const deliver = (channel: string, message: string) => {
      try {
        const event = EventName.parse(channel.slice(EVENT_CHANNEL_PREFIX.length));
        onEvent(event, EVENTS[event].schema.parse(JSON.parse(message)) as EventPayload<typeof event>);
      } catch (e) {
        onInvalid?.(channel, e as Error);
      }
    };
    if (events === 'all') {
      sub.on('pmessage', (_pattern: string, channel: string, message: string) => deliver(channel, message));
      await sub.psubscribe(`${EVENT_CHANNEL_PREFIX}*`);
    } else {
      sub.on('message', deliver);
      await sub.subscribe(...events.map(eventChannel));
    }
    return async () => {
      this.subs.delete(sub);
      await sub.quit();
    };
  }

  async close() {
    await Promise.all([...this.subs].map((s) => s.quit()));
    this.subs.clear();
    await this.redis.quit();
  }
}

/** The real-mode bus for `real(cfg)`: `<SVC>_VALKEY_URL` is required there (a fake uses MemoryBus). */
export function busFromConfig(service: string, cfg: { VALKEY_URL?: string }): ValkeyBus {
  if (!cfg.VALKEY_URL) throw new Error(`${service}: real mode needs ${service.toUpperCase()}_VALKEY_URL`);
  return new ValkeyBus(cfg.VALKEY_URL, service);
}

export type StreamItem = { id: string; entry: LogEntry } | { id: string; invalid: string };

/**
 * audit's reader for `log:actions`, in the consumer group `audit`. Read the entries this consumer was handed but
 * never acked first (`pending: true`, after a restart), then new ones. Ack an entry once its row is written.
 * An entry that fails the LogEntry schema comes back as `invalid` (with its raw text) so audit can record it.
 */
export class LogStreamReader {
  private readonly redis: Redis;

  constructor(
    url: string,
    private readonly consumer: string,
  ) {
    this.redis = valkeyClient(url, `audit-${consumer}`);
  }

  /** Creates the group from the start of the stream (and the stream, if no service has logged yet). */
  async ensureGroup() {
    try {
      await this.redis.xgroup('CREATE', LOG_STREAM, LOG_CONSUMER_GROUP, '0', 'MKSTREAM');
    } catch (e) {
      if (!String((e as Error).message).startsWith('BUSYGROUP')) throw e;
    }
  }

  async read(opts: { count?: number; blockMs?: number; pending?: boolean } = {}): Promise<StreamItem[]> {
    const args = ['GROUP', LOG_CONSUMER_GROUP, this.consumer, 'COUNT', opts.count ?? 100] as const;
    const id = opts.pending ? '0' : '>';
    const res = (opts.blockMs && !opts.pending
      ? await this.redis.xreadgroup(...args, 'BLOCK', opts.blockMs, 'STREAMS', LOG_STREAM, id)
      : await this.redis.xreadgroup(...args, 'STREAMS', LOG_STREAM, id)) as [string, [string, string[]][]][] | null;
    const items: StreamItem[] = [];
    for (const [, entries] of res ?? []) {
      for (const [entryId, fields] of entries) {
        const raw = fields[fields.indexOf('entry') + 1] ?? '';
        try {
          items.push({ id: entryId, entry: LogEntry.parse(JSON.parse(raw)) });
        } catch {
          items.push({ id: entryId, invalid: raw.slice(0, 2000) });
        }
      }
    }
    return items;
  }

  async ack(ids: string[]) {
    if (ids.length) await this.redis.xack(LOG_STREAM, LOG_CONSUMER_GROUP, ...ids);
  }

  /** Drops acked entries older than `minId` (audit calls it after its rows are durable). */
  async trim(minId: string) {
    await this.redis.xtrim(LOG_STREAM, 'MINID', minId);
  }

  async close() {
    await this.redis.quit();
  }
}
