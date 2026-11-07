import { EVENTS, LogEntry, type EventName, type EventPayload } from '@app/contracts';
import type { Bus } from '@app/service-kit';

/** What /live listens to: every event, as it's published. The Valkey one subscribes to `events.*`. */
export type EventHandler = (event: EventName, payload: unknown) => void;
export interface EventFeed {
  subscribe(h: EventHandler): () => void;
}

/**
 * An in-process bus that is also a feed: services in the same process (the tests) emit, /live pushes. In real mode
 * edge feeds it from ValkeyBus.subscribe('all') with `deliver`. It keeps nothing, so a long-running edge doesn't grow.
 */
export class LocalBus implements Bus, EventFeed {
  private readonly handlers = new Set<EventHandler>();
  async emit<E extends EventName>(event: E, payload: EventPayload<E>) {
    const p = EVENTS[event].schema.parse(payload);
    for (const h of this.handlers) h(event, p);
  }
  async log(entry: LogEntry) {
    LogEntry.parse(entry);
  }
  /** An event that is already validated (ValkeyBus checks it against its schema before handing it over). */
  deliver(event: EventName, payload: unknown) {
    for (const h of this.handlers) h(event, payload);
  }
  subscribe(h: EventHandler) {
    this.handlers.add(h);
    return () => void this.handlers.delete(h);
  }
}
