/**
 * board's rules, shared by the fake and the real service: catalog validation, default profiles, run jobs,
 * the result check, movement flags and first-paint quotes. No storage in here.
 */
import { createHash } from 'node:crypto';
import {
  MARKETS,
  WidgetRunJob,
  displayEntry,
  widgetRunJobId,
  type DisplayType,
  ProposalChange,
  type Quote,
  type RunKind,
  type RunTraceStep,
  type Verdict,
  type Widget,
  type WidgetDraft,
  type WidgetProfile,
  type WidgetResult,
  type WidgetSpec,
} from '@app/contracts';
import { checkPublish } from '@app/guard';
import { HttpError, type Call } from '@app/service-kit';
import type { z } from 'zod';

export type DisplaySpec = Extract<WidgetSpec, { kind: 'display' }>;
type Tune = Extract<z.infer<typeof ProposalChange>, { op: 'tune' }>;
type DraftLike = Pick<WidgetDraft, 'type' | 'size' | 'market_ids' | 'params'>;

/** "Refresh now" at most this many times per widget per hour (then 429). */
export const REFRESH_PER_HOUR = 12;

/** The demo cap on one board's widgets, folders and their tiles counted. The prescribed board stays under it. */
export const MAX_WIDGETS = 80;

/** Accept refuses adds past MAX_WIDGETS (409). */
export function checkWidgetCap(have: number, adding: number): void {
  if (adding > 0 && have + adding > MAX_WIDGETS)
    throw new HttpError(409, 'board_full', `a board holds at most ${MAX_WIDGETS} widgets; remove some first`);
}

/** Checks a display against its catalog entry: the size, the params it may use, and its markets. Throws 400. */
export function validateDisplay(d: DraftLike): void {
  const e = displayEntry(d.type);
  if (d.size && !e.sizes.includes(d.size)) throw new HttpError(400, 'bad_size', `${d.type} has no size ${d.size}`);
  const extra = Object.keys(d.params).filter((k) => !(e.params as string[]).includes(k));
  if (extra.length) throw new HttpError(400, 'bad_params', `${d.type} takes no ${extra.join(', ')}`);
  if (e.needs_markets && d.market_ids.length === 0) throw new HttpError(400, 'no_markets', `${d.type} needs a market`);
  if (new Set(d.market_ids).size !== d.market_ids.length) throw new HttpError(400, 'duplicate_market', 'a market is listed twice');
}

/** Checks a tune change against the widget it changes. Throws 400. */
export function validateTune(c: Tune, spec: WidgetSpec): void {
  if (spec.kind !== 'display') {
    if (c.size || c.user_probability !== undefined || c.threshold_pts !== undefined || c.brief !== undefined)
      throw new HttpError(400, 'not_a_display', 'only displays can be tuned');
    return;
  }
  const params = { ...spec.params };
  if (c.user_probability !== undefined) params.user_probability = c.user_probability;
  if (c.threshold_pts !== undefined) params.threshold_pts = c.threshold_pts;
  validateDisplay({ type: spec.type, size: c.size ?? spec.size, market_ids: spec.market_ids, params });
}

/** The tuned spec and brief, after validateTune passed. */
export function applyTune(c: Tune, spec: DisplaySpec): DisplaySpec {
  return {
    ...spec,
    size: c.size ?? spec.size,
    params: {
      ...spec.params,
      ...(c.user_probability !== undefined && { user_probability: c.user_probability }),
      ...(c.threshold_pts !== undefined && { threshold_pts: c.threshold_pts }),
    },
  };
}

export function defaultProfile(widget_id: string, type: DisplayType, brief = ''): WidgetProfile {
  const e = displayEntry(type);
  return { widget_id, brief, source_ids: [...e.default_sources], added_domains: [], cadence: { ...e.default_cadence }, feedback: [], last_math_plan: null };
}

/** The job for one widget run. The id collapses duplicates inside one minute's window. */
export function runJob(spec: DisplaySpec, kind: RunKind, reason: WidgetRunJob['reason'], at = Date.now()): WidgetRunJob {
  const window_start = Math.floor(at / 60_000) * 60;
  return WidgetRunJob.parse({
    job_id: widgetRunJobId(spec.widget_id, kind, window_start),
    widget_id: spec.widget_id,
    account_id: spec.account_id,
    kind,
    window_start,
    reason,
  });
}

/** Which run "Refresh now" starts: research for types that read sources, numbers otherwise. */
export const refreshKind = (spec: DisplaySpec): RunKind => (displayEntry(spec.type).research ? 'research' : 'numbers');

export interface PutResultBody {
  account_id: string;
  result: WidgetResult;
  verdict: Verdict;
  trace: RunTraceStep[];
}

/**
 * A result is stored only with its passing publish verdict, and board runs guard layer one again itself:
 * a runner that lies about the verdict still can't publish advice or an unreceipted number. Throws 422 or 400.
 */
export function checkResult(body: PutResultBody, spec: WidgetSpec): void {
  const v = body.verdict;
  if (v.stage !== 'publish' || v.outcome !== 'pass' || v.verdict_id !== body.result.verdict_id)
    throw new HttpError(422, 'no_passing_verdict', 'a result needs its passing publish verdict');
  const again = checkPublish(body.result);
  if (again.outcome !== 'pass')
    throw new HttpError(422, 'guard_refused', `board's own guard check failed: ${again.reasons.map((r) => r.code).join(', ')}`);
  if (spec.kind !== 'display') throw new HttpError(400, 'not_a_display', 'only displays have results');
  if (body.result.widget_id !== spec.widget_id) throw new HttpError(400, 'wrong_widget', 'result is for another widget');
  if (body.trace.some((s) => s.widget_id !== spec.widget_id || s.run_id !== body.result.run_id))
    throw new HttpError(400, 'wrong_trace', 'trace steps must belong to this widget and run');
}

/** A movement widget whose result moved past its threshold raises movement.flagged (in points). */
export function movementFlag(spec: WidgetSpec, result: WidgetResult): { market_id: string; move_pts: number; threshold_pts: number } | null {
  if (spec.kind !== 'display' || spec.type !== 'movement' || !spec.market_ids[0]) return null;
  const threshold_pts = spec.params.threshold_pts;
  if (threshold_pts === undefined) return null;
  const move = result.numbers.find((n) => n.op === 'movement');
  if (!move) return null;
  const move_pts = move.unit === 'probability' ? move.value * 100 : move.value;
  return Math.abs(move_pts) >= threshold_pts ? { market_id: spec.market_ids[0], move_pts, threshold_pts } : null;
}

/** First paint: cached prices from markets for every market id, fetched once each. A market that fails is left out. */
export async function fetchQuotes(markets: Call | undefined, marketIds: string[], timeoutMs = 2000): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (!markets) return out;
  const ids = [...new Set(marketIds)];
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs).unref());
  await Promise.all(
    ids.map(async (market_id) => {
      const m = await Promise.race([markets(MARKETS.get, { params: { market_id } }).catch(() => null), timeout]);
      if (m)
        out.set(market_id, {
          market_id: m.market_id,
          exchange: m.exchange,
          yes_price_cents: m.yes_price_cents,
          previous_price_cents: m.previous_price_cents,
          as_of: m.as_of,
          stale: m.stale,
        });
    }),
  );
  return out;
}

export const quotesFor = (spec: WidgetSpec, all: Map<string, Quote>): Quote[] =>
  spec.kind === 'display' ? spec.market_ids.map((id) => all.get(id)).filter((q): q is Quote => !!q) : [];

/** Every market id on the default board, so first paint fetches each once. */
export const allMarketIds = (specs: { market_ids: string[] }[]) => specs.flatMap((s) => s.market_ids);

/** The screenshot's Object Storage key. Ids only, so the key never carries page text. */
export const screenshotKey = (widget_id: string, run_id: string, candidate_id: string) => `screenshots/${widget_id}/${run_id}/${candidate_id}.png`;

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A widget as the API shows it: quotes only until the first result lands. */
export function view(w: Widget): Widget {
  if (w.result || !w.quotes?.length) {
    const { quotes: _q, ...rest } = w;
    return rest;
  }
  return w;
}

/** Grid width on desktop. */
export const GRID_COLS = 8;

/**
 * Places tiles on the grid in order, row by row (a simple shelf packing): displays by their catalog size, apps and
 * folders 1 x 1. The web app reflows for the phone; board only keeps places that don't overlap.
 */
export function packPlaces(sizes: ([number, number] | readonly [number, number])[], startRow = 0): { col: number; row: number }[] {
  let col = 0;
  let row = startRow;
  let shelf = 0;
  return sizes.map(([w, h]) => {
    if (col + w > GRID_COLS) {
      col = 0;
      row += shelf;
      shelf = 0;
    }
    const place = { col, row };
    col += w;
    shelf = Math.max(shelf, h);
    return place;
  });
}
