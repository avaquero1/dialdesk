/**
 * The step's model spend for `make e2e-live`, in one JSON file shared by every run of the step (E2E_LIVE_USAGE). Every
 * row counts as today's, so the caps hold for the whole step across runs and UTC days. Rows hold ids and numbers only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { UsageRow, UsageStore } from '../../services/models/src/meter.ts';

/** The most this step may spend on model calls (the operator's brief for C2.1). */
export const STEP_LIMIT_USD = 1;

export class StepUsageStore implements UsageStore {
  constructor(private path: string) {}
  rows(): UsageRow[] {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as UsageRow[]) : [];
  }
  async load(day: string) {
    return this.rows().map((r) => ({ ...r, day }));
  }
  async add(r: UsageRow) {
    const rows = this.rows();
    const cur = rows.find((x) => x.account === r.account && x.role === r.role && x.model === r.model);
    if (cur) {
      cur.calls += r.calls;
      cur.input_tokens += r.input_tokens;
      cur.output_tokens += r.output_tokens;
      cur.cost_usd += r.cost_usd;
    } else rows.push({ ...r });
    writeFileSync(this.path, JSON.stringify(rows, null, 2) + '\n');
  }
  total() {
    return this.rows().reduce((n, r) => n + r.cost_usd, 0);
  }
}
