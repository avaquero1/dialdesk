/**
 * board's rules, shared by the fake and the real service: catalog validation, default profiles, run jobs,
 * the result check, movement flags and first-paint quotes. No storage in here.
 */
import { createHash } from 'node:crypto';
import {
  CONNECTIONS,
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
  type WidgetSince,
  type WidgetSpec,
} from '@app/contracts';
import { checkPublish } from '@app/guard';
import { HttpError, RUN_RULES, type Call } from '@app/service-kit';
import type { z } from 'zod';

export type DisplaySpec = Extract<WidgetSpec, { kind: 'display' }>;
type Tune = Extract<z.infer<typeof ProposalChange>, { op: 'tune' }>;
type DraftLike = Pick<WidgetDraft, 'type' | 'size' | 'market_ids' | 'params'>;

/** "Refresh now" at most this many times per widget per hour (then 429 too_many_refreshes). */
export const REFRESH_PER_HOUR = 12;

/** "Refresh now" at most this many times per account per hour (then 429 refresh_cap). The reason is in RUN_RULES. */
export const REFRESH_PER_ACCOUNT_HOUR = RUN_RULES.refreshesPerAccountHour;

/**
 * The refresh limits, on the refreshes of the last hour that put a new run on the queue (a joined refresh is never
 * counted, nor refused). The account's cap comes first: past it, every widget answers the same plain "too fast".
 */
export function checkRefresh(widgetHour: number, accountHour: number): void {
  if (accountHour >= REFRESH_PER_ACCOUNT_HOUR) throw new HttpError(429, 'refresh_cap', 'too many refreshes on this account this hour');
  if (widgetHour >= REFRESH_PER_HOUR) throw new HttpError(429, 'too_many_refreshes', 'this widget was refreshed too often this hour');
}

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

/**
 * A "Your account" link: the connection must be one of this account's (connections.list, which holds no key and no
 * numbers). 404 otherwise, the same answer as for a connection that does not exist. Without connections, no link.
 */
export async function ownConnection(connections: Call | undefined, account_id: string, connection_id: string): Promise<void> {
  if (!connections) throw new HttpError(404, 'not_found', 'no such connection');
  const { connections: list } = await connections(CONNECTIONS.list, { query: { account_id } });
  if (!list.some((c) => c.connection_id === connection_id)) throw new HttpError(404, 'not_found', 'no such connection');
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
  checkSince(body.result);
}

/**
 * A movement widget whose result moved past its threshold raises movement.flagged (in points), on the game of the
 * published move: its receipt's provenance (Biggest move picks one game of many), else the widget's only market.
 */
export function movementFlag(spec: WidgetSpec, result: WidgetResult): { market_id: string; move_pts: number; threshold_pts: number } | null {
  if (spec.kind !== 'display' || spec.type !== 'movement') return null;
  const threshold_pts = spec.params.threshold_pts;
  if (threshold_pts === undefined) return null;
  const move = result.numbers.find((n) => n.op === 'movement');
  if (!move) return null;
  const receipt = result.receipts.find((r) => r.id === move.receipt_id);
  const market_id = receipt?.provenance?.series?.source ?? (spec.market_ids.length === 1 ? spec.market_ids[0] : undefined);
  if (!market_id) return null;
  const move_pts = move.unit === 'probability' ? move.value * 100 : move.value;
  return Math.abs(move_pts) >= threshold_pts ? { market_id, move_pts, threshold_pts } : null;
}

// ---------- "since you last looked" (N1.2.1) ----------

/**
 * A visit: the owner's board reads (edge's getBoard) less than this far apart. A read after a longer gap starts a new
 * visit, and the strip then compares with what the owner saw at the end of the last one. BOARD_VISIT_GAP_S overrides it.
 */
export const VISIT_GAP_S = 30 * 60;

/** True when a read now would start a new visit: never opened, or the last read is older than the gap. */
export const isAway = (lastOpenedAt: string | Date | null | undefined, gapS: number, nowMs = Date.now()) =>
  !lastOpenedAt || nowMs - new Date(lastOpenedAt).getTime() > gapS * 1000;

/**
 * The result the move is measured from. Board keeps two per widget: `seen`, current at the owner's last read, and
 * `baseline`, what `seen` was when this visit began (the previous visit's). While the owner is away, the next visit's
 * previous visit is the last read, so a run compares with `seen`; during a visit, with `baseline`.
 */
export const baselineOf = (away: boolean, seen: WidgetResult | null | undefined, baseline: WidgetResult | null | undefined) =>
  (away ? seen : baseline) ?? null;

/**
 * The strip's data: the current result's engine moves, when runner measured them from this baseline, and how many of
 * its items are new. null when there is nothing to compare with, or nothing changed.
 */
export function sinceOf(cur: WidgetResult | null, base: WidgetResult | null): WidgetSince | null {
  if (!cur || !base || cur.result_id === base.result_id) return null;
  const s = cur.since?.from_result_id === base.result_id ? cur.since : null;
  const had = new Set(base.facts.map((f) => f.claim));
  const new_items = cur.facts.filter((f) => !had.has(f.claim)).length;
  if (!s?.numbers.length && !new_items) return null;
  return { from_result_id: base.result_id, from_at: base.created_at, numbers: s?.numbers ?? [], receipts: s?.receipts ?? [], new_items };
}

/** Every since number has its receipt, with the same value (board shows no number without one). */
export function checkSince(result: WidgetResult): void {
  const s = result.since;
  if (!s) return;
  for (const n of s.numbers) {
    const r = s.receipts.find((x) => x.id === n.receipt_id);
    if (!r || r.value !== n.value || n.op !== 'gap') throw new HttpError(400, 'bad_since', 'a since number needs its gap receipt');
  }
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

/** A tile as makeFolder sees it: its kind and where it sits. */
export type TileRef = { widget_id: string; kind: WidgetSpec['kind']; place: WidgetSpec['place'] };
type GridPlace = { col: number; row: number };

/**
 * makeFolder's checks and plan, the same on both stores. 404 for a widget not on this board, 400 for a duplicate, an app
 * or a folder in the list. The folder takes `place`, else the first widget's grid place (for a widget inside a folder:
 * that folder's place when this empties it, else `below`). `emptied`: the folders every child of which moves in, which
 * the same change removes. Then the cap: the new folder counts, the emptied folders don't.
 */
export function planFolder(
  tiles: Map<string, TileRef>,
  widget_ids: string[],
  place: GridPlace | undefined,
  below: () => GridPlace,
): { place: GridPlace; emptied: string[] } {
  if (new Set(widget_ids).size !== widget_ids.length) throw new HttpError(400, 'duplicate', 'a widget is in the list twice');
  for (const id of widget_ids) {
    const t = tiles.get(id);
    if (!t) throw new HttpError(404, 'not_found', 'no such widget');
    if (t.kind !== 'display') throw new HttpError(400, 'not_display', "only displays go in a folder: no apps, and folders don't nest");
  }
  const moving = new Set(widget_ids);
  const emptied = [...tiles.values()]
    .filter((f) => f.kind === 'folder')
    .map((f) => f.widget_id)
    .filter((fid) => {
      const kids = [...tiles.values()].filter((t) => 'folder_id' in t.place && t.place.folder_id === fid);
      return kids.length > 0 && kids.every((k) => moving.has(k.widget_id));
    });
  const first = tiles.get(widget_ids[0]!)!.place;
  const from = (p: WidgetSpec['place']): GridPlace | null => ('col' in p ? p : null);
  const own = 'folder_id' in first && emptied.includes(first.folder_id) ? from(tiles.get(first.folder_id)!.place) : from(first);
  checkWidgetCap(tiles.size - emptied.length, 1);
  return { place: place ?? own ?? below(), emptied };
}
