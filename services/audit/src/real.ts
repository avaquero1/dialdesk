import { AUDIT } from '@app/contracts';
import { HttpError, LogStreamReader, createLogger, now, type Handlers } from '@app/service-kit';
import { z } from 'zod';
import { Consumer, DEFAULTS, type ConsumerOptions } from './consumer.ts';
import { DirHeadStore, type HeadStore } from './heads.ts';
import { Signer } from './signer.ts';
import { PgAuditStore } from './store.ts';
import { verifyChain } from './verify.ts';

const ms = (d: number) => z.coerce.number().int().min(1).default(d);
/** audit's own variables (after the AUDIT_ prefix). */
export const AuditConfig = z.object({
  DATABASE_URL: z.string().min(1, 'real mode needs AUDIT_DATABASE_URL'),
  VALKEY_URL: z.string().min(1, 'real mode needs AUDIT_VALKEY_URL'),
  /** The Ed25519 signing key (PKCS#8 PEM). `make dev-secrets` writes one into deploy/.dev/. */
  SIGNING_KEY_FILE: z.string().min(1).default('/run/secrets/audit-signing-key'),
  /** Write-once storage for the signed heads: a folder (dev, and the fallback if the bucket isn't up). */
  HEADS_DIR: z.string().min(1).default('/var/lib/audit/heads'),
  /** This process's consumer name in the group `audit`. Keep it stable across restarts. */
  CONSUMER: z.string().regex(/^[a-z0-9-]{1,40}$/).default('audit-1'),
  CLAIM_IDLE_MS: ms(DEFAULTS.claimIdleMs),
  CLAIM_EVERY_MS: ms(DEFAULTS.claimEveryMs),
  BLOCK_MS: ms(DEFAULTS.blockMs),
  PUSH_EVERY_MS: ms(DEFAULTS.pushEveryMs),
});
export type AuditConfig = z.infer<typeof AuditConfig>;

export type AuditDeps = { store: PgAuditStore; signer: Signer; heads: HeadStore; consumer: Consumer };

/** Builds audit's parts and opens the chain, without starting the loop (the tests drive `consumer.step()`). */
export async function openAudit(cfg: AuditConfig): Promise<AuditDeps> {
  const log = createLogger('audit');
  const store = new PgAuditStore(cfg.DATABASE_URL);
  const signer = Signer.fromFile(cfg.SIGNING_KEY_FILE);
  const heads = new DirHeadStore(cfg.HEADS_DIR);
  const opts: ConsumerOptions = {
    ...DEFAULTS,
    claimIdleMs: cfg.CLAIM_IDLE_MS,
    claimEveryMs: cfg.CLAIM_EVERY_MS,
    blockMs: cfg.BLOCK_MS,
    pushEveryMs: cfg.PUSH_EVERY_MS,
  };
  const consumer = new Consumer(new LogStreamReader(cfg.VALKEY_URL, cfg.CONSUMER), store, signer, heads, log, opts);
  await consumer.open();
  await consumer.push();
  return { store, signer, heads, consumer };
}

/** The read-only routes edge forwards. Every number comes from the chain itself. */
export function auditHandlers(d: Omit<AuditDeps, 'consumer'>): Handlers<typeof AUDIT> {
  const head = async () => {
    const h = await d.store.latestHead();
    if (!h) throw new Error('audit: no head yet');
    return h;
  };
  return {
    trust: async ({ query }) => ({ ...(await d.store.trust(query.account_id, now().slice(0, 10))), head: await head() }),
    head,
    verify: ({ query }) => verifyChain(d, query),
    row: async ({ params, query }) => {
      const r = await d.store.byId(params.row_id);
      if (!r || r.entry.account_id !== query.account_id) throw new HttpError(404, 'not_found', 'no such row');
      const { seq, row_id, prev_hash, hash, entry } = r;
      return { seq, row_id, prev_hash, hash, entry };
    },
  };
}

/** The real audit: the log-stream consumer in the background, and the read-only routes. */
export async function real(raw: Record<string, unknown> = {}): Promise<Handlers<typeof AUDIT>> {
  const parsed = AuditConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`bad config for audit: ${parsed.error.issues.map((i) => `AUDIT_${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const deps = await openAudit(parsed.data);
  deps.consumer.start();
  return auditHandlers(deps);
}
