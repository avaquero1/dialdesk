/**
 * A board's numbers batch (A1.4.1): one compute box per board per tick, instead of one per widget.
 *
 * The scheduler enqueues one numbers job per board (the first widget's job id) and saves the batch's widget ids.
 * handleBoardNumbers runs every widget of the batch as its own run (its own run_state row, trace, receipts and
 * publish, through handleRun), side by side. Each run gets its inputs as it always does, then hands its engine input
 * to the batch instead of opening a box. When every run has handed its input in or finished without one (or after
 * RUN_RULES.schedule.batchWaitMs), the batch puts the inputs in one engine plan, each widget's ids under its own
 * prefix (`b<i>_`), and runs it in one compute box. Each run gets back its own numbers (ids without the prefix),
 * its own receipts and errors. The engine's receipts are kept as the engine wrote them: their op ids and refs carry
 * the prefix, and their plan hash is the batch's plan, the plan that really ran.
 *
 * A batch that doesn't fit one box (BOX_LIMITS) goes in as few as fit (A1.4.3), one after the other: widgets stay in
 * order and each widget's plan stays whole. A box that fails fails only its own widgets.
 *
 * A box's trust rows (created, destroyed) are forwarded once, by the run whose box it is.
 */
import { EngineResult, QUEUES, widgetRunJobId, type EngineInput, type SbxJobStatus, type WidgetRunJob, type WidgetSpec } from '@app/contracts';
import { NoRetry, QUEUE_RULES, RUN_RULES, RetryLater, SandboxBusy, type JobCtx } from '@app/service-kit';
import { handleRun, type BatchSlot, type ComputeRunner, type RunnerDeps } from './run.ts';
import type { RunRecord } from './store.ts';

type DisplaySpec = Extract<WidgetSpec, { kind: 'display' }>;
/** The engine's id rule: lowercase, digits and _, at most 32. */
const ENGINE_ID = /^[a-z][a-z0-9_]{0,31}$/;
/** The engine's PLAN_VERSION: merge() writes one version for the whole plan. */
const PLAN_VERSION = 1;
/** What one compute box takes: the engine's MAX_OPS, the manager's request body (axum's default, 2 MiB less the envelope) and the box's output limit (Limits::COMPUTE). */
export const BOX_LIMITS = { ops: 256, inputBytes: 2 * 1024 * 1024 - 4096, outputBytes: 256 * 1024 };
/** The most an op's number, receipt and plan row take in the output besides its call and provenance (measured: 480-690 over every op, with a 40-char git hash). */
const OP_OUTPUT_BYTES = 700;

interface Part {
  run: ComputeRunner;
  spec: DisplaySpec;
  input: EngineInput;
  resolve: (j: SbxJobStatus | null) => void;
  reject: (e: unknown) => void;
}
type Member = { p: Part; prefix: string };

/**
 * Collects the engine inputs of `n` runs (more can `join` until it fires) and computes them in one box. It fires when
 * every member has handed its input in or left, and at least `gatherMs` after the first input; at the latest `waitMs`
 * after the first input.
 */
export class ComputeBatch {
  /** undefined: not yet; null: finished without an input; a Part: waiting for the box. */
  private readonly parts: (Part | null | undefined)[];
  fired = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstAt: number | null = null;
  /** How many boxes this batch opened (tests and the load test read it). */
  boxes = 0;
  constructor(
    n: number,
    readonly waitMs: number = RUN_RULES.schedule.batchWaitMs,
    readonly gatherMs = 0,
    readonly onFire?: () => void,
  ) {
    this.parts = new Array(n).fill(undefined);
  }

  /** A new member's slot, or null when the batch has fired already. */
  join(): (BatchSlot & { leave(): void }) | null {
    if (this.fired) return null;
    this.parts.push(undefined);
    return this.slot(this.parts.length - 1);
  }

  /** Member i's slot: its compute goes in the batch; `leave` when its run ends (with or without an input). */
  slot(i: number): BatchSlot & { leave(): void } {
    return {
      compute: (run, spec, input) => {
        if (this.fired) return this.solo(run, spec, input);
        return new Promise<SbxJobStatus | null>((resolve, reject) => {
          this.parts[i] = { run, spec, input, resolve, reject };
          if (this.firstAt === null) {
            this.firstAt = Date.now();
            this.timer = setTimeout(() => void this.fire(), this.waitMs);
            if (this.gatherMs) setTimeout(() => this.maybeFire(), this.gatherMs);
          }
          this.maybeFire();
        });
      },
      leave: () => {
        if (this.parts[i] === undefined) this.parts[i] = null;
        this.maybeFire();
      },
    };
  }

  private maybeFire() {
    if (this.fired || this.firstAt === null || Date.now() - this.firstAt < this.gatherMs) return;
    if (this.parts.every((p) => p !== undefined)) void this.fire();
  }

  private solo(run: ComputeRunner, spec: DisplaySpec, input: EngineInput) {
    this.boxes++;
    return run.computeOne(spec, input);
  }

  private async fire() {
    if (this.fired) return;
    this.fired = true;
    if (this.timer) clearTimeout(this.timer);
    this.onFire?.();
    const parts = this.parts.flatMap((p, i) => (p ? [{ p, prefix: `b${i}_` }] : []));
    const fit = parts.filter(({ p, prefix }) => fits(p.input, prefix));
    // A widget the engine would refuse, or whose ids don't fit under a prefix, computes alone: its refusal stays its own.
    for (const { p } of parts.filter((x) => !fit.includes(x))) this.solo(p.run, p.spec, p.input).then(p.resolve, p.reject);
    // One after the other: a board holds one compute box at a time, however many it needs.
    for (const box of intoBoxes(fit)) await this.computeBox(box);
  }

  /** Computes one box; a failure stays with this box's widgets. */
  private async computeBox(box: Member[]) {
    if (box.length === 1) {
      const { p } = box[0]!;
      return this.solo(p.run, p.spec, p.input).then(p.resolve, p.reject);
    }
    const first = box[0]!.p;
    try {
      const j = await this.solo(first.run, first.spec, merge(box.map(({ p, prefix }) => ({ input: p.input, prefix }))));
      for (const { p, prefix } of box) p.resolve(j && sliceStatus(j, prefix, p !== first));
    } catch (e) {
      for (const { p } of box) p.reject(e);
    }
  }
}

const pre = (prefix: string, id: string) => `${prefix}${id}`;
/** False when the engine's plan checks would refuse this input (check_plan): one widget's refusal would fail the whole box. */
function fits(input: EngineInput, prefix: string) {
  const ops = input.plan.ops.map((o) => o.id);
  const has = (k: string) => Object.hasOwn(input.numbers, k);
  const named = [...Object.keys(input.origins ?? {}), ...Object.keys(input.provenance ?? {})];
  const provenance = Object.values(input.provenance ?? {});
  return (
    input.plan.plan_version === PLAN_VERSION &&
    [...Object.keys(input.numbers), ...ops].every((id) => ENGINE_ID.test(pre(prefix, id))) &&
    new Set(ops).size === ops.length &&
    !ops.some(has) &&
    named.every(has) &&
    provenance.every((p) => inRange(p.source, 200) && inRange(p.as_of, 40))
  );
}
const inRange = (s: string, max: number) => s.length > 0 && Buffer.byteLength(s) <= max;
const prefixKeys = <V>(o: Record<string, V> | undefined, prefix: string) =>
  Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [pre(prefix, k), v]));

/** One engine input from many: every number key and op id under its widget's prefix, the ops in widget order. */
export function merge(parts: { input: EngineInput; prefix: string }[]): EngineInput {
  const out: EngineInput = { plan: { plan_version: parts[0]!.input.plan.plan_version, ops: [] }, numbers: {}, origins: {}, provenance: {} };
  for (const { input, prefix } of parts) {
    out.plan.ops.push(
      ...input.plan.ops.map((o) => ({ ...o, id: pre(prefix, o.id), args: Object.fromEntries(Object.entries(o.args).map(([k, v]) => [k, pre(prefix, v)])) })),
    );
    Object.assign(out.numbers, prefixKeys(input.numbers, prefix));
    Object.assign(out.origins!, prefixKeys(input.origins, prefix));
    Object.assign(out.provenance!, prefixKeys(input.provenance, prefix));
  }
  return out;
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** What a widget takes of a box. The output is estimated from the op's call (the plan row and the receipt's refs) and its args' provenance. */
function boxCost({ p: { input }, prefix }: Member) {
  const m = merge([{ input, prefix }]);
  const outputBytes = m.plan.ops.reduce(
    (n, o) => n + OP_OUTPUT_BYTES + 2 * bytes(o) + Object.values(o.args).reduce((a, k) => a + bytes(m.provenance?.[k] ?? ''), 0),
    0,
  );
  return { ops: m.plan.ops.length, inputBytes: bytes(m), outputBytes };
}

/**
 * The batch's widgets in boxes: in order, each box filled until the next widget would break a limit, which gives the
 * fewest boxes that keep the order. A widget too big for a box on its own gets a box of its own and fails alone.
 */
function intoBoxes(members: Member[]): Member[][] {
  const out: Member[][] = [];
  let used = { ops: 0, inputBytes: 0, outputBytes: 0 };
  for (const m of members) {
    const c = boxCost(m);
    const over = used.ops + c.ops > BOX_LIMITS.ops || used.inputBytes + c.inputBytes > BOX_LIMITS.inputBytes || used.outputBytes + c.outputBytes > BOX_LIMITS.outputBytes;
    if (!out.length || over) {
      out.push([]);
      used = { ops: 0, inputBytes: 0, outputBytes: 0 };
    }
    out.at(-1)!.push(m);
    used = { ops: used.ops + c.ops, inputBytes: used.inputBytes + c.inputBytes, outputBytes: used.outputBytes + c.outputBytes };
  }
  return out;
}

/** One widget's part of an engine result: its numbers (ids without the prefix), its receipts, its errors and the plan's. */
export function slice(er: EngineResult, prefix: string): EngineResult {
  const mine = (id: string) => id.startsWith(prefix);
  const strip = (id: string) => id.slice(prefix.length);
  const numbers = er.numbers.filter((n) => mine(n.id)).map((n) => ({ ...n, id: strip(n.id) }));
  const errors = er.errors.filter((e) => e.op_id === 'plan' || mine(e.op_id)).map((e) => (e.op_id === 'plan' ? e : { ...e, op_id: strip(e.op_id) }));
  return { ...er, numbers, errors, receipts: er.receipts.filter((r) => mine(r.op_id)), ok: errors.length === 0 };
}

/** The box's status for one widget: its part of the result. The box's trust rows go only to the run that opened it. */
function sliceStatus(j: SbxJobStatus, prefix: string, other: boolean): SbxJobStatus {
  const er = j.state === 'done' ? EngineResult.safeParse(j.compute_result) : null;
  const out: SbxJobStatus = { ...j, ...(er?.success ? { compute_result: slice(er.data, prefix) } : {}) };
  if (other) out.trust_log = [];
  return out;
}

/**
 * The numbers runs of one account that reach the worker together, outside a scheduled batch: a new board's first runs
 * (one per display at sign-up) and accepts. Each joins the account's open batch, which gathers for
 * RUN_RULES.schedule.gatherMs, so the worker's slots open one box per account at a time instead of one per run.
 */
export class AccountBatches {
  private readonly open = new Map<string, ComputeBatch>();
  constructor(readonly gatherMs: number = RUN_RULES.schedule.gatherMs) {}
  join(account_id: string): BatchSlot & { leave(): void } {
    const cur = this.open.get(account_id)?.join();
    if (cur) return cur;
    const b: ComputeBatch = new ComputeBatch(0, RUN_RULES.schedule.batchWaitMs, this.gatherMs, () => {
      if (this.open.get(account_id) === b) this.open.delete(account_id);
    });
    this.open.set(account_id, b);
    return b.join()!;
  }
}

/**
 * One board's numbers job: every widget of the batch as its own run, their math in one box. The job waits or retries
 * when a run must (busy, an infrastructure error); runs that finished return at once on the retry (run_state).
 */
export async function handleBoardNumbers(d: RunnerDeps, lead: WidgetRunJob, ctx: JobCtx, widget_ids: string[], batch?: ComputeBatch): Promise<RunRecord[]> {
  const ids = [...new Set([lead.widget_id, ...widget_ids])];
  const b = batch ?? new ComputeBatch(ids.length);
  const settled = await Promise.allSettled(
    ids.map((id, i) => {
      const job: WidgetRunJob = id === lead.widget_id ? lead : { ...lead, widget_id: id, job_id: widgetRunJobId(id, 'numbers', lead.window_start) };
      const slot = b.slot(i);
      return handleRun({ ...d, batch: slot }, job, ctx).finally(() => slot.leave());
    }),
  );
  const errs = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason as unknown] : []));
  const wait = errs.find((e) => e instanceof RetryLater || e instanceof SandboxBusy);
  if (wait) throw wait;
  const again = errs.find((e) => !(e instanceof NoRetry));
  if (again && !ctx.signal.aborted && ctx.attempt < QUEUE_RULES[QUEUES.widgetRuns].attempts) throw again;
  return settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
}
