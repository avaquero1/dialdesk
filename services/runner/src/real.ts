/**
 * The real runner: consumes widget-runs (BullMQ on Valkey), runs each widget's steps (run.ts) against board, markets,
 * models and sandbox-manager, keeps run_state and the schedule on Postgres, and enqueues the cadence runs.
 * Its HTTP API is read-only: getRun.
 *
 * Env: RUNNER_DATABASE_URL, RUNNER_VALKEY_URL, RUNNER_TOKEN_<CALLEE> / RUNNER_URL_<CALLEE> for board, markets, models,
 * connections and sandbox-manager, RUNNER_SOURCE_ENV (prod | fixture, default prod), RUNNER_SCHEDULE_TICK_MS (default 30000).
 */
import { BOARD, QUEUES, RUNNER, type WidgetRunJob } from '@app/contracts';
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
  type Logger,
} from '@app/service-kit';
import { AccountBatches, handleBoardNumbers } from './batch.ts';
import { handleRun, type RunnerDeps } from './run.ts';
import { Scheduler, type OpenedFn } from './scheduler.ts';
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

/**
 * One widget-runs job: a board's numbers batch (the scheduler saved one under this job id), or one widget's run. With
 * `together`, a numbers run shares its box with the account's other numbers runs in the worker at the same time.
 */
export async function runJob(deps: RunnerDeps, job: WidgetRunJob, ctx: Parameters<typeof handleRun>[2], together?: AccountBatches) {
  const batch = job.kind === 'numbers' && job.reason === 'schedule' ? await deps.store.batches.get(job.job_id) : null;
  if (!batch) {
    const slot = together && job.kind === 'numbers' ? together.join(job.account_id) : null;
    const r = await (slot ? handleRun({ ...deps, batch: slot }, job, ctx).finally(() => slot.leave()) : handleRun(deps, job, ctx));
    return { run_id: r.run_id, status: r.status, runs: 1 };
  }
  const rs = await handleBoardNumbers(deps, job, ctx, batch.widget_ids);
  const lead = rs.find((r) => r.widget_id === job.widget_id);
  return { run_id: lead?.run_id ?? null, status: lead?.status ?? 'failed', runs: rs.length };
}

/** board's lastOpened, as the scheduler reads it. */
export const openedFrom =
  (board: RunnerDeps['board']): OpenedFn =>
  async (account_ids) => {
    const r = await board(BOARD.lastOpened, { body: { account_ids } });
    return new Map(r.boards.map((b) => [b.account_id, b.last_opened_at ? Date.parse(b.last_opened_at) : null]));
  };

/** The widget-runs worker: each job is one runJob on `deps`. `opts` is for tests (faster rules). */
export function consumeWidgetRuns(deps: RunnerDeps, valkey: string, log: Logger, opts: Parameters<typeof createWorker>[4] = {}) {
  const together = new AccountBatches();
  return createWorker(
    QUEUES.widgetRuns,
    valkey,
    'runner',
    async (job, ctx) => {
      const t0 = Date.now();
      try {
        const r = await runJob(deps, job, ctx, together);
        log.info({ job_id: job.job_id, run_id: r.run_id, status: r.status, runs: r.runs, ms: Date.now() - t0 }, 'run ended');
      } catch (e) {
        log.warn({ job_id: job.job_id, attempt: ctx.attempt, err: e instanceof Error ? e.name : 'error', msg: e instanceof Error ? e.message.slice(0, 200) : '' }, 'run did not finish');
        throw e;
      }
    },
    opts,
  );
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
  const board = await clientFromEnv('runner', 'board');
  const scheduler = new Scheduler(store, (j) => queue.enqueue(j), Date.now, openedFrom(board));
  const sm = calleeConfig('runner', 'sandbox-manager');
  if (!sm.token) throw new Error('runner: RUNNER_TOKEN_SANDBOX_MANAGER is required in real mode');
  const deps: RunnerDeps = {
    board,
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
    testPageDomain: typeof cfg.TESTPAGE_DOMAIN === 'string' ? cfg.TESTPAGE_DOMAIN : '',
    onRunEnd: (w, job) => scheduler.noteRun(w, job),
    onWidgetGone: (id) => scheduler.forget(id),
  };
  consumeWidgetRuns(deps, valkey, log);
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
