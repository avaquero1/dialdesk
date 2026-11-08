/**
 * The cadence runs ("Run rules"): numbers every 1-5 min, research every 30-60 min, each from the widget's profile.
 * runner learns a widget from the first run board enqueues for it (accept), books the next run after each one, and
 * a tick enqueues what is due on widget-runs with reason `schedule`. The job id carries the cadence window, so a
 * second enqueue in the same window collapses into the first.
 *
 * The runs fit the sandbox machine (RUN_RULES.schedule, A1.4.1):
 * - Only boards in use: numbers for boards their owner opened in the last 3 hours, research in the last day. board
 *   answers when each board was last read by its owner (BOARD.lastOpened); a user-started run (accept, refresh,
 *   clear) counts as a visit too.
 * - A display inside a folder (the game cards) runs its numbers at the slow speed (folderNumbersEveryS).
 * - One numbers job per board per tick: the board's due numbers widgets are one batch, saved under the first
 *   widget's job id, and runner computes them in one compute box (batch.ts). Research stays one job per widget.
 */
import { widgetRunJobId, type RunKind, type Widget, type WidgetRunJob } from '@app/contracts';
import { RUN_RULES } from '@app/service-kit';
import type { ScheduleRow, Store } from './store.ts';

const RULES = RUN_RULES.schedule;
export const ACTIVE_FOR_MS = RULES.researchOpenForMs;
const USER_REASONS = new Set<WidgetRunJob['reason']>(['accept', 'refresh', 'clear']);

/** When each board was last opened by its owner, ms since the epoch (missing or null: never, or unknown). */
export type OpenedFn = (account_ids: string[]) => Promise<Map<string, number | null>>;

export class Scheduler {
  constructor(
    readonly store: Store,
    readonly enqueue: (job: WidgetRunJob) => Promise<unknown>,
    readonly now: () => number = Date.now,
    /** board's lastOpened. Without it, only user-started runs count as a visit. */
    readonly opened?: OpenedFn,
  ) {}

  /** After a run: book the next one of the same kind from the profile's cadence (or drop it when the cadence is off). */
  async noteRun(w: Widget, job: Pick<WidgetRunJob, 'kind' | 'reason'>) {
    if (w.spec.kind !== 'display' || !w.profile) return;
    const kinds: RunKind[] = ['numbers', 'research'];
    const inFolder = 'folder_id' in w.spec.place;
    for (const kind of kinds) {
      const every_s = everyS(kind, w.profile.cadence, inFolder);
      const row = await this.store.schedule.get(w.spec.widget_id, kind);
      if (!every_s) {
        if (row) await this.store.schedule.remove(w.spec.widget_id, kind);
        continue;
      }
      const t = this.now();
      const userRun = USER_REASONS.has(job.reason);
      const active_at = userRun ? t : (row?.active_at ?? t);
      // The kind that just ran moves to its next window; the other keeps its time (or starts now). A new speed (the
      // widget moved into or out of a folder) takes the nearer of its old time and the new speed's next window.
      const next_at =
        kind === job.kind || !row ? nextWindow(t, every_s) : row.every_s !== every_s ? Math.min(row.next_at, nextWindow(t, every_s)) : row.next_at;
      await this.store.schedule.put({ widget_id: w.spec.widget_id, kind, account_id: w.spec.account_id, every_s, next_at, active_at });
    }
  }

  async forget(widget_id: string) {
    await this.store.schedule.remove(widget_id);
  }

  /** Enqueue every due run: one numbers job per board, one research job per widget. Returns the jobs it enqueued. */
  async tick(limit = 2000): Promise<WidgetRunJob[]> {
    const t = this.now();
    const due = await this.store.schedule.due(t, limit);
    if (!due.length) return [];
    const opened = await this.lastOpened([...new Set(due.map((r) => r.account_id))]);
    const out: WidgetRunJob[] = [];
    const numbers = new Map<string, ScheduleRow[]>();
    for (const row of due) {
      const seen = Math.max(row.active_at, opened.get(row.account_id) ?? 0);
      const openFor = row.kind === 'numbers' ? RULES.numbersOpenForMs : RULES.researchOpenForMs;
      if (t - seen > openFor) {
        // A board not in use: no run until its owner opens it again. Look again in the next window.
        await this.store.schedule.put({ ...row, next_at: nextWindow(t, row.every_s) });
        continue;
      }
      if (row.kind === 'numbers') numbers.set(row.account_id, [...(numbers.get(row.account_id) ?? []), row]);
      else {
        const job = jobFor(row, t);
        await this.enqueue(job);
        await this.store.schedule.put({ ...row, next_at: nextWindow(t, row.every_s) });
        out.push(job);
      }
    }
    for (const rows of numbers.values()) {
      const lead = jobFor(rows[0]!, t);
      if (rows.length > 1) await this.store.batches.put({ job_id: lead.job_id, account_id: lead.account_id, widget_ids: rows.map((r) => r.widget_id) });
      await this.enqueue(lead);
      for (const r of rows) await this.store.schedule.put({ ...r, next_at: nextWindow(t, r.every_s) });
      out.push(lead);
    }
    return out;
  }

  /** board's answer. When board can't be reached, only user-started runs count (fewer runs, never more). */
  private async lastOpened(account_ids: string[]): Promise<Map<string, number | null>> {
    if (!this.opened) return new Map();
    const out = new Map<string, number | null>();
    for (let i = 0; i < account_ids.length; i += 200) {
      const part = await this.opened(account_ids.slice(i, i + 200)).catch(() => new Map<string, number | null>());
      for (const [k, v] of part) out.set(k, v);
    }
    return out;
  }
}

/** The cadence a widget runs at: its profile's, and for numbers inside a folder at most the slow speed. */
export function everyS(kind: RunKind, cadence: { numbers_every_s: number | null; research_every_s: number | null }, inFolder: boolean): number | null {
  if (kind === 'research') return cadence.research_every_s;
  const n = cadence.numbers_every_s;
  return n && inFolder ? Math.max(n, RULES.folderNumbersEveryS) : n;
}

function jobFor(row: ScheduleRow, t: number): WidgetRunJob {
  const window_start = Math.floor(t / 1000 / row.every_s) * row.every_s;
  return {
    job_id: widgetRunJobId(row.widget_id, row.kind, window_start),
    widget_id: row.widget_id,
    account_id: row.account_id,
    kind: row.kind,
    window_start,
    reason: 'schedule',
  };
}

/** The start of the next cadence window after `t`, in ms. */
export const nextWindow = (t: number, every_s: number) => (Math.floor(t / 1000 / every_s) + 1) * every_s * 1000;
