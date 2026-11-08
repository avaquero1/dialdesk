import { DelayedError, Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { BULL_PREFIX, JOBS, QUEUES, widgetRunJobId, type AccountRefreshJob, type WidgetRunJob } from '@app/contracts';
import { SandboxBusy } from './sandbox.ts';
import { valkeyClient } from './valkey.ts';

/**
 * The job queues on Valkey (BullMQ, prefix `bull`): `widget-runs` (board -> runner) and `account-refresh`
 * (connections -> connections). The job id is the payload's `job_id`; for a widget run that is
 * `<widget>:<kind>:<window_start>`, so a second enqueue for the same window collapses into the first.
 */
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export type JobData<Q extends QueueName> = Q extends typeof QUEUES.widgetRuns ? WidgetRunJob : AccountRefreshJob;

/** The run rules from the architecture ("Run rules"), in one place for runner and the queues. */
export const RUN_RULES = {
  timeoutsMs: { browse: 30_000, extract: 30_000, compute: 5_000, summary: 20_000, run: 180_000 },
  /** Model calls: two retries with backoff, on 429 and 5xx only. */
  modelRetries: { retries: 2, baseMs: 1_000 },
  /** Sandbox jobs: one retry on an infrastructure error, never on poison. */
  sandboxRetries: { retries: 1, baseMs: 2_000 },
  /** About 6 Chromium sandboxes fit on 8 GB. */
  sandboxSlots: 6,
  /**
   * runner's scheduler (A1.4.1). The sandbox machine (a VX1, 2 vCPUs) is shared by every user of the public demo,
   * and one board has about 30 displays, so the cadence runs are rationed:
   */
  schedule: {
    /**
     * Numbers runs only for boards their owner opened (read through edge) in the last 3 hours. Nobody sees a 2-minute
     * price on a board that is closed, and a judge's or guest's visit lasts minutes, not hours. When the owner opens it
     * again, the next window (at most one cadence, 2 min by default) runs it; until then it shows its last numbers.
     */
    numbersOpenForMs: 3 * 3600_000,
    /** Research runs only for boards opened in the last day ("Run rules"). */
    researchOpenForMs: 24 * 3600_000,
    /**
     * A display inside a folder (the game cards) runs its numbers at the slow speed: at most every 30 min. It is out
     * of sight until its folder opens. Top-level displays keep their own cadence (the fast speed).
     */
    folderNumbersEveryS: 1800,
    /**
     * One compute box per board per tick: the board's due numbers widgets go in one engine plan. The batch waits at
     * most this long for every widget to have its inputs; a widget later than that computes alone.
     */
    batchWaitMs: 10_000,
    /**
     * Numbers runs of one account that reach the worker together (a new board's first runs: one per display at sign-up)
     * share one box too: the first input waits this long for the others. It costs first paint 0.3 s.
     */
    gatherMs: 300,
  },
} as const;

export interface QueueRule {
  /** Total attempts, counting the first. */
  attempts: number;
  backoff: { type: 'exponential' | 'fixed'; delay: number };
  /** The handler's abort signal fires at this time; the job then fails without a retry. */
  timeoutMs: number;
  concurrency: number;
  /** How long a job stays `busy`-delayed before it fails as `busy`. */
  maxBusyMs: number;
  /** Finished jobs are kept this long, so a re-enqueue of the same id stays collapsed. */
  keepCompletedS: number;
  keepFailedS: number;
}

export const QUEUE_RULES: Record<QueueName, QueueRule> = {
  // One retry (runner resumes from run_state), only for infrastructure errors: poison and timeouts throw NoRetry.
  [QUEUES.widgetRuns]: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: RUN_RULES.timeoutsMs.run,
    concurrency: RUN_RULES.sandboxSlots,
    maxBusyMs: 10 * 60_000,
    keepCompletedS: 6 * 3600,
    keepFailedS: 24 * 3600,
  },
  [QUEUES.accountRefresh]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 60_000,
    concurrency: 2,
    maxBusyMs: 10 * 60_000,
    keepCompletedS: 3600,
    keepFailedS: 24 * 3600,
  },
};

/** Throw it (or wrap an error in it) from a handler to fail the job without a retry: poison, timeouts, bad input. */
export class NoRetry extends UnrecoverableError {
  constructor(
    readonly reason: string,
    message = reason,
  ) {
    super(message);
    this.name = 'NoRetry';
  }
}

/** Throw it from a handler when the work can't start yet (sandbox-manager answered busy): no attempt is spent. */
export class RetryLater extends Error {
  constructor(readonly afterMs: number) {
    super(`retry in ${afterMs} ms`);
    this.name = 'RetryLater';
  }
}

export interface JobCtx {
  jobId: string;
  /** 1 on the first try. */
  attempt: number;
  /** Fires at the queue's timeoutMs. Pass it down to every call. */
  signal: AbortSignal;
}

export type JobHandler<Q extends QueueName> = (data: JobData<Q>, ctx: JobCtx) => Promise<void>;

/** The producer side. `enqueue` validates the payload against JOBS and returns the BullMQ job id. */
export function createQueue<Q extends QueueName>(name: Q, url: string, service: string, rules: Partial<QueueRule> = {}) {
  const rule = { ...QUEUE_RULES[name], ...rules };
  // BullMQ doesn't close a connection it was handed, so close() does.
  const conn = valkeyClient(url, `${service}-q-${name}`);
  const queue = new Queue(name, { connection: conn, prefix: BULL_PREFIX });
  return {
    queue,
    async enqueue(data: JobData<Q>, opts: { delayMs?: number; priority?: number } = {}) {
      const job = JOBS[name].schema.parse(data) as JobData<Q>;
      if (name === QUEUES.widgetRuns) {
        const w = job as WidgetRunJob;
        const want = widgetRunJobId(w.widget_id, w.kind, w.window_start);
        if (w.job_id !== want) throw new Error(`widget run job_id must be ${want}, got ${w.job_id}`);
      }
      const added = await queue.add(name, job, {
        jobId: job.job_id,
        attempts: rule.attempts,
        backoff: rule.backoff,
        removeOnComplete: { age: rule.keepCompletedS },
        removeOnFail: { age: rule.keepFailedS },
        ...(opts.delayMs && { delay: opts.delayMs }),
        ...(opts.priority && { priority: opts.priority }),
      });
      return added.id as string;
    },
    async close() {
      await queue.close();
      await conn.quit();
    },
  };
}

/**
 * The consumer side. The handler gets the validated payload and an abort signal at the queue's timeout.
 * - throws NoRetry (or times out): the job fails now.
 * - throws RetryLater or SandboxBusy: the job waits and runs again without spending an attempt (until maxBusyMs).
 * - throws anything else: retried with backoff until `attempts` is used up.
 */
export function createWorker<Q extends QueueName>(
  name: Q,
  url: string,
  service: string,
  handler: JobHandler<Q>,
  opts: { autorun?: boolean; rules?: Partial<QueueRule> } = {},
) {
  const rule = { ...QUEUE_RULES[name], ...opts.rules };
  const run = async (job: Job, token?: string) => {
    const parsed = JOBS[name].schema.safeParse(job.data);
    if (!parsed.success) throw new NoRetry('bad_job', `job ${job.id} payload: ${parsed.error.message}`);
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort(new NoRetry('timeout', `job ${job.id} ran past ${rule.timeoutMs} ms`));
        reject(ac.signal.reason);
      }, rule.timeoutMs);
    });
    try {
      await Promise.race([handler(parsed.data as JobData<Q>, { jobId: job.id as string, attempt: job.attemptsMade + 1, signal: ac.signal }), timeout]);
    } catch (e) {
      const later = e instanceof RetryLater ? e.afterMs : e instanceof SandboxBusy ? e.retryAfterMs : null;
      if (later === null) throw e;
      if (Date.now() - job.timestamp + later > rule.maxBusyMs) throw new NoRetry('busy', `job ${job.id} stayed busy past ${rule.maxBusyMs} ms`);
      await job.moveToDelayed(Date.now() + later, token);
      throw new DelayedError();
    } finally {
      clearTimeout(timer);
    }
  };
  // BullMQ's blocking connection must never give up on a request (maxRetriesPerRequest: null).
  const conn = valkeyClient(url, `${service}-w-${name}`, { maxRetriesPerRequest: null });
  const worker = new Worker(name, run, {
    connection: conn,
    prefix: BULL_PREFIX,
    concurrency: rule.concurrency,
    autorun: opts.autorun ?? true,
  });
  return {
    worker,
    async close() {
      await worker.close();
      await conn.quit();
    },
  };
}
