/**
 * A small TTL cache keyed by what is fetched (a market, an event, a feed, a search), never by who asked. Every user who
 * follows a market reads the same entry. Concurrent misses share one fetch. When a refresh fails, the last value is
 * served with `stale: true` (the architecture's "exchange down" rule).
 */
export interface Cached<T> {
  value: T;
  /** ms since epoch when the value was fetched */
  at: number;
  stale: boolean;
}

interface Entry {
  value: unknown;
  at: number;
}

export class TtlCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Cached<unknown>>>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly max = 5000,
    private readonly clock: () => number = Date.now,
  ) {}

  /** `staleIf` decides which failures may fall back to the last value (default: none). */
  async get<T>(key: string, ttlMs: number, load: () => Promise<T>, opts: { staleIf?: (err: unknown) => boolean } = {}): Promise<Cached<T>> {
    const e = this.entries.get(key);
    const t = this.clock();
    if (e && t - e.at < ttlMs) {
      this.hits++;
      return { value: e.value as T, at: e.at, stale: false };
    }
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<Cached<T>>;
    this.misses++;
    const p = (async (): Promise<Cached<unknown>> => {
      await null; // registered in `inflight` before load() runs, even if it throws at once
      try {
        const value = await load();
        const at = this.clock();
        this.set(key, { value, at });
        return { value, at, stale: false };
      } catch (err) {
        if (e && opts.staleIf?.(err)) return { value: e.value, at: e.at, stale: true };
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p as Promise<Cached<T>>;
  }

  peek<T>(key: string): Cached<T> | null {
    const e = this.entries.get(key);
    return e ? { value: e.value as T, at: e.at, stale: false } : null;
  }

  put(key: string, value: unknown, at = this.clock()) {
    this.set(key, { value, at });
  }

  get size() {
    return this.entries.size;
  }

  private set(key: string, entry: Entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
