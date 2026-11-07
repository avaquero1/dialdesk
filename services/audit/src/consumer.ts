import type { LogStreamReader, Logger, StreamItem } from '@app/service-kit';
import { logEntry, now } from '@app/service-kit';
import { sha256 } from './chain.ts';
import type { HeadStore } from './heads.ts';
import type { Signer } from './signer.ts';
import type { Incoming, PgAuditStore } from './store.ts';

export type ConsumerOptions = {
  /** Take over another consumer's unacked entries after this long (it died). */
  claimIdleMs: number;
  /** How often to look for them. */
  claimEveryMs: number;
  /** How long one XREADGROUP waits for new entries. */
  blockMs: number;
  /** How often the newest signed head goes to write-once storage. */
  pushEveryMs: number;
  batch: number;
};
export const DEFAULTS: ConsumerOptions = { claimIdleMs: 60_000, claimEveryMs: 30_000, blockMs: 2_000, pushEveryMs: 30_000, batch: 100 };

/**
 * An entry that fails the LogEntry schema still becomes a row, but only as its hash and size: its text could be
 * anything (page text, a key), so it never reaches the table.
 */
export function toIncoming(item: StreamItem): Incoming {
  if ('entry' in item) return { stream_id: item.id, entry: item.entry };
  return {
    stream_id: item.id,
    entry: logEntry('audit', 'log.invalid', {
      outcome: 'refused',
      ids: { stream_id: item.id },
      hashes: { raw: sha256(item.invalid) },
      sizes: { raw: Buffer.byteLength(item.invalid) },
    }),
  };
}

/** Postgres jsonb can't hold \u0000; such an entry would fail its whole batch forever, so it is recorded as invalid. */
const storable = (item: StreamItem): StreamItem =>
  'entry' in item && JSON.stringify(item.entry).includes('\\u0000') ? { id: item.id, invalid: JSON.stringify(item.entry) } : item;

/**
 * audit's single loop: claim what dead consumers left, re-read its own unacked entries, then new ones; append them
 * to the chain, ack, sign the new head and trim the stream below anything still pending. A failed append acks
 * nothing, so the entries are read again (and the stream id makes the retry idempotent).
 */
export class Consumer {
  private running = false;
  private loop: Promise<void> | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private lastClaim = 0;

  constructor(
    private readonly reader: LogStreamReader,
    private readonly store: PgAuditStore,
    private readonly signer: Signer,
    private readonly heads: HeadStore,
    private readonly log: Logger,
    private readonly opts: ConsumerOptions = DEFAULTS,
  ) {}

  /** Creates the group, the chain's first row if the chain is empty, signs the head and publishes the public key. */
  async open() {
    await this.reader.ensureGroup();
    if (!(await this.store.last())) {
      await this.store.append([{ stream_id: null, entry: logEntry('audit', 'audit.chain_started', { outcome: 'ok', ids: { key_id: this.signer.keyId } }) }]);
    }
    await this.signHead();
    await this.heads.putKey(this.signer.keyId, this.signer.publicPem);
  }

  start() {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          await this.step();
        } catch (e) {
          this.log.error({ err: (e as Error).message }, 'audit: step failed, retrying');
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
    this.pushTimer = setInterval(() => void this.push().catch((e: Error) => this.log.error({ err: e.message }, 'audit: head push failed')), this.opts.pushEveryMs);
  }

  /** One pass. Returns how many rows it wrote. */
  async step(): Promise<number> {
    if (Date.now() - this.lastClaim >= this.opts.claimEveryMs) {
      this.lastClaim = Date.now();
      const { items: claimed, deleted } = await this.reader.claimStale(this.opts.claimIdleMs, this.opts.batch);
      if (claimed.length) this.log.info({ entries: claimed.length }, 'audit: claimed entries from a dead consumer');
      if (deleted.length) this.log.warn({ entries: deleted.length }, 'audit: pending entries were trimmed before audit read them');
    }
    // Pending first: what this consumer was handed (or just claimed) but hasn't acked.
    let items: StreamItem[] = await this.reader.read({ pending: true, count: this.opts.batch });
    if (!items.length) items = await this.reader.read({ count: this.opts.batch, blockMs: this.running ? this.opts.blockMs : undefined });
    if (!items.length) return 0;
    const rows = await this.store.append(items.map(storable).map(toIncoming));
    await this.reader.ack(items.map((i) => i.id));
    if (rows.length) await this.signHead();
    await this.trim(items.at(-1)!.id);
    return rows.length;
  }

  /** Drop stream entries below the oldest one any consumer still holds (or below the last one acked). */
  private async trim(lastAcked: string) {
    const oldest = await this.reader.oldestPending();
    const cmp = (a: string, b: string) => {
      const [am, as] = a.split('-').map(BigInt) as [bigint, bigint];
      const [bm, bs] = b.split('-').map(BigInt) as [bigint, bigint];
      return am === bm ? (as < bs ? -1 : as > bs ? 1 : 0) : am < bm ? -1 : 1;
    };
    await this.reader.trim(oldest && cmp(oldest, lastAcked) < 0 ? oldest : lastAcked);
  }

  async signHead() {
    const last = await this.store.last();
    const current = await this.store.latestHead();
    if (!last || current?.seq === last.seq) return current;
    const head = this.signer.sign({ seq: last.seq, hash: last.hash, signed_at: now() });
    await this.store.saveHead(head);
    return head;
  }

  /** Pushes the newest head to write-once storage, if it isn't there yet. */
  async push() {
    const head = await this.store.unpushedHead();
    if (!head) return null;
    const { key } = await this.heads.put(head);
    await this.store.recordPush(head.seq, key, this.heads.kind);
    this.log.info({ seq: head.seq, key }, 'audit: head pushed');
    return key;
  }

  async stop() {
    this.running = false;
    if (this.pushTimer) clearInterval(this.pushTimer);
    await this.loop;
  }

  async close() {
    await this.stop();
    await this.reader.close();
  }
}
