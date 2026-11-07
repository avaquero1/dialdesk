import { EVENTS, LogEntry, type EventName, type EventPayload } from '@app/contracts';
import type { Bus } from '@app/service-kit';

/** What /live listens to: every event, as it's published. The Valkey one subscribes to `events.*`. */
export type EventHandler = (event: EventName, payload: unknown) => void;
export interface EventFeed {
  subscribe(h: EventHandler): () => void;
}

/**
 * An in-process bus that is also a feed: services in the same process (the tests, a one-process demo) emit, /live
 * pushes. It keeps nothing, so a long-running edge doesn't grow. Replaced by the Valkey feed when service-kit has it.
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
  subscribe(h: EventHandler) {
    this.handlers.add(h);
    return () => void this.handlers.delete(h);
  }
}
