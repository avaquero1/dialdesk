import { serve } from '@hono/node-server';
import type { Endpoint, ServiceName } from '@app/contracts';
import { buildApp, type Handlers, type SessionCheck } from './app.ts';
import { parseCallers } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { migrate, pendingMigrations } from './migrate.ts';

export interface ServiceDef<T extends Record<string, Endpoint>> {
  service: ServiceName;
  api: T;
  /** The in-memory fake that honors the contract (used with <SVC>_FAKE=1, by other builders and by the tests). */
  fake: () => Handlers<T> | Promise<Handlers<T>>;
  /** The real handlers. Phase 0: every one is `notImplemented`. */
  real: (cfg: Record<string, unknown>) => Handlers<T> | Promise<Handlers<T>>;
  /** services/<name>/migrations, for services that store data. */
  migrationsDir?: string;
  /**
   * The NOLOGIN role that owns the service's tables, when it isn't the service's own login (audit: audit_owner).
   * The service then never migrates itself: the deploy applies them as this role (`migrate({ role })` from an admin
   * login), and at start the service only checks that none is pending, and refuses to start if one is.
   */
  migrationsOwner?: string;
  sessionCheck?: SessionCheck;
}

/** `main.ts` of every service: config, logs, migrations (real mode), then listen. */
export async function runService<T extends Record<string, Endpoint>>(def: ServiceDef<T>) {
  const cfg = loadConfig(def.service) as ReturnType<typeof loadConfig> & { PORT: number; HOST: string; FAKE: boolean; CALLERS: string; DATABASE_URL?: string };
  const log = createLogger(def.service);
  const mode = cfg.FAKE ? 'fake' : 'real';
  if (mode === 'real' && def.migrationsDir) {
    if (!cfg.DATABASE_URL) log.warn('no DATABASE_URL: migrations skipped');
    else if (def.migrationsOwner) {
      const pending = await pendingMigrations({ databaseUrl: cfg.DATABASE_URL, schema: def.service, dir: def.migrationsDir });
      if (pending.length > 0) {
        throw new Error(`${def.service}: migrations not applied (${pending.join(', ')}): apply them as ${def.migrationsOwner} first (npm run migrate -w services/${def.service})`);
      }
    } else await migrate({ databaseUrl: cfg.DATABASE_URL, schema: def.service, dir: def.migrationsDir, log });
  }
  const app = buildApp({
    service: def.service,
    mode,
    api: def.api,
    handlers: mode === 'fake' ? await def.fake() : await def.real(cfg),
    callers: parseCallers(cfg.CALLERS),
    log,
    sessionCheck: def.sessionCheck,
  });
  const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: cfg.HOST }, (info) =>
    log.info({ port: info.port, mode }, 'listening'),
  );
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}
