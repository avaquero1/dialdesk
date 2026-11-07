/**
 * The real runner: consumes widget-runs (BullMQ on Valkey), runs each widget's steps (run.ts) against board, markets,
 * models and sandbox-manager, keeps run_state and the schedule on Postgres, and enqueues the cadence runs.
 * Its HTTP API is read-only: getRun.
 *
 * Env: RUNNER_DATABASE_URL, RUNNER_VALKEY_URL, RUNNER_TOKEN_<CALLEE> / RUNNER_URL_<CALLEE> for board, markets, models,
 * connections and sandbox-manager, RUNNER_SOURCE_ENV (prod | fixture, default prod), RUNNER_SCHEDULE_TICK_MS (default 30000).
 */
import { QUEUES, RUNNER } from '@app/contracts';
import {
  HttpError,
  busFromConfig,
  calleeConfig,
  clientFromEnv,
  createLogger,
  createQueue,
  createWorker,
  sandboxClient,
  type Handlers,
} from '@app/service-kit';
import { handleRun, type RunnerDeps } from './run.ts';
import { Scheduler } from './scheduler.ts';
import { PgStore, connect, toRunState, type Store } from './store.ts';

export function getRunHandlers(store: Store): Handlers<typeof RUNNER> {
  return {
    getRun: async ({ params }) => {
      const r = await store.get(params.run_id);
      if (!r) throw new HttpError(404, 'not_found', 'no such run');
      return toRunState(r);
    },
  };
}

export async function real(cfg: Record<string, unknown>): Promise<Handlers<typeof RUNNER>> {
  const url = cfg.DATABASE_URL;
  if (typeof url !== 'string' || !url) throw new Error('runner: RUNNER_DATABASE_URL is required in real mode');
  const valkey = typeof cfg.VALKEY_URL === 'string' ? cfg.VALKEY_URL : undefined;
  if (!valkey) throw new Error('runner: RUNNER_VALKEY_URL is required in real mode');
  const log = createLogger('runner');
  const store = new PgStore(connect(url));
  const bus = busFromConfig('runner', { VALKEY_URL: valkey });
  const queue = createQueue(QUEUES.widgetRuns, valkey, 'runner');
  const scheduler = new Scheduler(store, (j) => queue.enqueue(j));
  const sm = calleeConfig('runner', 'sandbox-manager');
  if (!sm.token) throw new Error('runner: RUNNER_TOKEN_SANDBOX_MANAGER is required in real mode');
  const deps: RunnerDeps = {
    board: await clientFromEnv('runner', 'board'),
    markets: await clientFromEnv('runner', 'markets'),
    models: await clientFromEnv('runner', 'models'),
    connections: await clientFromEnv('runner', 'connections'),
    sandbox: sandboxClient({ baseUrl: sm.url, token: sm.token }),
    bus,
    // The stream answers no row id; audit assigns it when it reads the entry.
    audit: async (e) => {
      await bus.log(e);
      return null;
    },
    store,
    sourceEnv: cfg.SOURCE_ENV === 'fixture' ? 'fixture' : 'prod',
    onRunEnd: (w, job) => scheduler.noteRun(w, job),
    onWidgetGone: (id) => scheduler.forget(id),
  };
  createWorker(QUEUES.widgetRuns, valkey, 'runner', async (job, ctx) => {
    const t0 = Date.now();
    try {
      const r = await handleRun(deps, job, ctx);
      log.info({ job_id: job.job_id, run_id: r.run_id, status: r.status, ms: Date.now() - t0 }, 'run ended');
    } catch (e) {
      log.warn({ job_id: job.job_id, attempt: ctx.attempt, err: e instanceof Error ? e.name : 'error', msg: e instanceof Error ? e.message.slice(0, 200) : '' }, 'run did not finish');
      throw e;
    }
  });
  const tickMs = Number(cfg.SCHEDULE_TICK_MS ?? 30_000) || 30_000;
  setInterval(() => {
    scheduler.tick().then(
      (jobs) => jobs.length && log.info({ enqueued: jobs.length }, 'schedule tick'),
      (e) => log.warn({ msg: e instanceof Error ? e.message.slice(0, 200) : '' }, 'schedule tick failed'),
    );
  }, tickMs).unref();
  log.info({ queue: QUEUES.widgetRuns, tickMs }, 'consuming');
  return getRunHandlers(store);
}
