/**
 * runner's state: run_state (one row per run, keyed by the job id so a retry or a busy wait resumes the same run)
 * and the schedule (one row per widget and kind with a cadence). MemoryStore for tests and the fake, PgStore on
 * Postgres (schema `runner`, migrations/0002_runner.sql).
 */
import type { RunKind, RunState, WidgetRunJob } from '@app/contracts';
import postgres from 'postgres';

/** A run as stored: the contract's RunState, plus each finished step's output (for resume) and the attempt. */
export interface RunRecord extends RunState {
  outputs: Record<string, unknown>;
  attempt: number;
}

export interface ScheduleRow {
  widget_id: string;
  kind: RunKind;
  account_id: string;
  every_s: number;
  /** ms since the epoch */
  next_at: number;
  /** ms since the epoch: the last run a user started */
  active_at: number;
}

/** One board's numbers widgets, computed in one compute box: the scheduler saves it under the first widget's job id. */
export interface Batch {
  job_id: string;
  account_id: string;
  widget_ids: string[];
}

export interface Store {
  /** The run for this job: the stored one (a retry, a busy wait or a duplicate), or a new one. */
  begin(job: WidgetRunJob, run_id: string, at: string): Promise<RunRecord>;
  save(rec: RunRecord): Promise<void>;
  get(run_id: string): Promise<RunRecord | null>;
  schedule: {
    get(widget_id: string, kind: RunKind): Promise<ScheduleRow | null>;
    put(row: ScheduleRow): Promise<void>;
    remove(widget_id: string, kind?: RunKind): Promise<void>;
    due(now: number, limit: number): Promise<ScheduleRow[]>;
  };
  batches: {
    put(b: Batch): Promise<void>;
    get(job_id: string): Promise<Batch | null>;
  };
}

export const toRunState = (r: RunRecord): RunState => {
  const { outputs: _o, attempt: _a, ...state } = r;
  return state;
};

const fresh = (job: WidgetRunJob, run_id: string, at: string): RunRecord => ({
  run_id,
  job_id: job.job_id,
  widget_id: job.widget_id,
  account_id: job.account_id,
  kind: job.kind,
  status: 'running',
  last_step: null,
  steps: [],
  started_at: at,
  finished_at: null,
  outputs: {},
  attempt: 1,
});

export class MemoryStore implements Store {
  readonly runs = new Map<string, RunRecord>();
  readonly byJob = new Map<string, string>();
  readonly rows = new Map<string, ScheduleRow>();
  async begin(job: WidgetRunJob, run_id: string, at: string) {
    const id = this.byJob.get(job.job_id);
    if (id) return structuredClone(this.runs.get(id)!);
    const rec = fresh(job, run_id, at);
    this.runs.set(run_id, rec);
    this.byJob.set(job.job_id, run_id);
    return structuredClone(rec);
  }
  async save(rec: RunRecord) {
    this.runs.set(rec.run_id, structuredClone(rec));
  }
  async get(run_id: string) {
    const r = this.runs.get(run_id);
    return r ? structuredClone(r) : null;
  }
  schedule = {
    get: async (widget_id: string, kind: RunKind) => this.rows.get(`${widget_id}:${kind}`) ?? null,
    put: async (row: ScheduleRow) => void this.rows.set(`${row.widget_id}:${row.kind}`, { ...row }),
    remove: async (widget_id: string, kind?: RunKind) => {
      for (const k of kind ? [kind] : (['numbers', 'research'] as const)) this.rows.delete(`${widget_id}:${k}`);
    },
    due: async (now: number, limit: number) =>
      [...this.rows.values()].filter((r) => r.next_at <= now).sort((a, b) => a.next_at - b.next_at).slice(0, limit),
  };
  readonly batchRows = new Map<string, Batch>();
  batches = {
    put: async (b: Batch) => void this.batchRows.set(b.job_id, structuredClone(b)),
    get: async (job_id: string) => structuredClone(this.batchRows.get(job_id) ?? null),
  };
}

type RunRow = Omit<RunRecord, 'started_at' | 'finished_at'> & { started_at: Date; finished_at: Date | null };
type SchedRow = Omit<ScheduleRow, 'next_at' | 'active_at'> & { next_at: Date; active_at: Date };

const fromRow = (r: RunRow): RunRecord => ({
  ...r,
  started_at: r.started_at.toISOString(),
  finished_at: r.finished_at ? r.finished_at.toISOString() : null,
});
const fromSched = (r: SchedRow): ScheduleRow => ({ ...r, next_at: r.next_at.getTime(), active_at: r.active_at.getTime() });

/** svc_runner's pool on schema `runner`. */
export const connect = (url: string) =>
  postgres(url, { max: 3, onnotice: () => {}, connection: { search_path: 'runner', application_name: 'runner' } });

export class PgStore implements Store {
  constructor(readonly sql: postgres.Sql) {}
  async begin(job: WidgetRunJob, run_id: string, at: string) {
    const r = fresh(job, run_id, at);
    await this.sql`
      insert into run_state (run_id, job_id, widget_id, account_id, kind, status, steps, outputs, started_at)
      values (${r.run_id}, ${r.job_id}, ${r.widget_id}, ${r.account_id}, ${r.kind}, 'running', '[]', '{}', ${r.started_at})
      on conflict (job_id) do nothing`;
    const [row] = await this.sql<RunRow[]>`select * from run_state where job_id = ${job.job_id}`;
    return fromRow(row!);
  }
  async save(r: RunRecord) {
    await this.sql`
      update run_state set status = ${r.status}, last_step = ${r.last_step}, steps = ${this.sql.json(r.steps as never)},
        outputs = ${this.sql.json(r.outputs as never)}, attempt = ${r.attempt}, finished_at = ${r.finished_at}
      where run_id = ${r.run_id}`;
  }
  async get(run_id: string) {
    const [row] = await this.sql<RunRow[]>`select * from run_state where run_id = ${run_id}`;
    return row ? fromRow(row) : null;
  }
  schedule = {
    get: async (widget_id: string, kind: RunKind) => {
      const [r] = await this.sql<SchedRow[]>`select * from schedule where widget_id = ${widget_id} and kind = ${kind}`;
      return r ? fromSched(r) : null;
    },
    put: async (s: ScheduleRow) => {
      await this.sql`
        insert into schedule (widget_id, kind, account_id, every_s, next_at, active_at)
        values (${s.widget_id}, ${s.kind}, ${s.account_id}, ${s.every_s}, ${new Date(s.next_at)}, ${new Date(s.active_at)})
        on conflict (widget_id, kind) do update set account_id = excluded.account_id, every_s = excluded.every_s,
          next_at = excluded.next_at, active_at = excluded.active_at`;
    },
    remove: async (widget_id: string, kind?: RunKind) => {
      if (kind) await this.sql`delete from schedule where widget_id = ${widget_id} and kind = ${kind}`;
      else await this.sql`delete from schedule where widget_id = ${widget_id}`;
    },
    due: async (now: number, limit: number) =>
      (await this.sql<SchedRow[]>`select * from schedule where next_at <= ${new Date(now)} order by next_at limit ${limit}`).map(fromSched),
  };
  batches = {
    put: async (b: Batch) => {
      // A batch is read once, by its job: a day is far past the job's retries and busy waits.
      await this.sql`delete from batches where created_at < now() - interval '1 day'`;
      await this.sql`insert into batches (job_id, account_id, widget_ids) values (${b.job_id}, ${b.account_id}, ${this.sql.json(b.widget_ids)})
                     on conflict (job_id) do nothing`;
    },
    get: async (job_id: string) => {
      const [r] = await this.sql<Batch[]>`select job_id, account_id, widget_ids from batches where job_id = ${job_id}`;
      return r ?? null;
    },
  };
}
