/**
 * Token buckets in memory (one edge instance). Each rule has a burst and a refill rate; a key is an address or an
 * account. `take` answers whether the request may go, and if not, how many seconds until it may.
 */
export interface Rule {
  burst: number;
  perSecond: number;
}

/** The edge's limits. Per address unless the name says account. */
export const DEFAULT_LIMITS = {
  /** Every /api request and /live handshake from one address. */
  address: { burst: 300, perSecond: 5 },
  /** Every /api request from one signed-in account. */
  account: { burst: 120, perSecond: 2 },
  signup: { burst: 5, perSecond: 5 / 600 },
  login: { burst: 10, perSecond: 10 / 300 },
  guest: { burst: 5, perSecond: 5 / 3600 },
  chat: { burst: 20, perSecond: 20 / 60 },
  refresh: { burst: 10, perSecond: 10 / 60 },
  live: { burst: 20, perSecond: 20 / 60 },
} satisfies Record<string, Rule>;
export type Limits = { [K in keyof typeof DEFAULT_LIMITS]: Rule };

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly rules: Limits,
    private readonly clock: () => number = Date.now,
    private readonly maxKeys = 200_000,
  ) {}

  take(rule: keyof Limits, key: string): { ok: true } | { ok: false; retryAfter: number } {
    const r = this.rules[rule];
    const id = `${rule}|${key}`;
    const t = this.clock();
    const b = this.buckets.get(id) ?? { tokens: r.burst, at: t };
    b.tokens = Math.min(r.burst, b.tokens + ((t - b.at) / 1000) * r.perSecond);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(id, b);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / r.perSecond)) };
    }
    b.tokens -= 1;
    if (!this.buckets.has(id) && this.buckets.size >= this.maxKeys) this.prune();
    this.buckets.set(id, b);
    return { ok: true };
  }

  /** Drops buckets that have refilled (they hold no state worth keeping); clears all if that isn't enough. */
  private prune() {
    const t = this.clock();
    for (const [id, b] of this.buckets) {
      const r = this.rules[id.slice(0, id.indexOf('|')) as keyof Limits];
      if (b.tokens + ((t - b.at) / 1000) * r.perSecond >= r.burst) this.buckets.delete(id);
    }
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}
