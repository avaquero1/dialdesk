/**
 * The cadence runs ("Run rules"): numbers every 1-5 min, research every 30-60 min, each from the widget's profile.
 * runner learns a widget from the first run board enqueues for it (accept), books the next run after each one, and
 * a tick enqueues what is due on widget-runs with reason `schedule`. The job id carries the cadence window, so a
 * second enqueue in the same window collapses into the first.
 *
 * Research runs only while the board is in use: a user-started run (accept, refresh, clear) in the last day.
 * board has no "opened" signal for runner yet, so that is the stand-in.
 */
import { widgetRunJobId, type RunKind, type Widget, type WidgetRunJob } from '@app/contracts';
import type { Store } from './store.ts';

export const ACTIVE_FOR_MS = 24 * 3600_000;
const USER_REASONS = new Set<WidgetRunJob['reason']>(['accept', 'refresh', 'clear']);

export class Scheduler {
  constructor(
    readonly store: Store,
    readonly enqueue: (job: WidgetRunJob) => Promise<unknown>,
    readonly now: () => number = Date.now,
  ) {}

  /** After a run: book the next one of the same kind from the profile's cadence (or drop it when the cadence is off). */
  async noteRun(w: Widget, job: Pick<WidgetRunJob, 'kind' | 'reason'>) {
    if (w.spec.kind !== 'display' || !w.profile) return;
    const kinds: RunKind[] = ['numbers', 'research'];
    for (const kind of kinds) {
      const every_s = kind === 'numbers' ? w.profile.cadence.numbers_every_s : w.profile.cadence.research_every_s;
      const row = await this.store.schedule.get(w.spec.widget_id, kind);
      if (!every_s) {
        if (row) await this.store.schedule.remove(w.spec.widget_id, kind);
        continue;
      }
      const t = this.now();
      const userRun = USER_REASONS.has(job.reason);
      const active_at = userRun ? t : (row?.active_at ?? t);
      // The kind that just ran moves to its next window; the other keeps its time (or starts now).
      const next_at = kind === job.kind || !row ? nextWindow(t, every_s) : row.next_at;
      await this.store.schedule.put({ widget_id: w.spec.widget_id, kind, account_id: w.spec.account_id, every_s, next_at, active_at });
    }
  }

  async forget(widget_id: string) {
    await this.store.schedule.remove(widget_id);
  }

  /** Enqueue every due run. Returns the jobs it enqueued. */
  async tick(limit = 200): Promise<WidgetRunJob[]> {
    const t = this.now();
    const out: WidgetRunJob[] = [];
    for (const row of await this.store.schedule.due(t, limit)) {
      const nextAt = nextWindow(t, row.every_s);
      if (row.kind === 'research' && t - row.active_at > ACTIVE_FOR_MS) {
        // Idle board: no research until a user starts a run again. Look again in the next window.
        await this.store.schedule.put({ ...row, next_at: nextAt });
        continue;
      }
      const window_start = Math.floor(t / 1000 / row.every_s) * row.every_s;
      const job: WidgetRunJob = {
        job_id: widgetRunJobId(row.widget_id, row.kind, window_start),
        widget_id: row.widget_id,
        account_id: row.account_id,
        kind: row.kind,
        window_start,
        reason: 'schedule',
      };
      await this.enqueue(job);
      await this.store.schedule.put({ ...row, next_at: nextAt });
      out.push(job);
    }
    return out;
  }
}

/** The start of the next cadence window after `t`, in ms. */
export const nextWindow = (t: number, every_s: number) => (Math.floor(t / 1000 / every_s) + 1) * every_s * 1000;
