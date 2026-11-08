/**
 * The real board on Postgres (schema `board`, role svc_board). Same rules as the fake (logic.ts); every query is
 * scoped by account_id. Events and runs go out after the transaction commits.
 *
 * Bus and queue: events and the log stream on Valkey (busFromConfig), runs on widget-runs (BullMQ, createQueue).
 */
import { resolve } from 'node:path';
import {
  BOARD,
  QUEUES,
  SIZE_CELLS,
  WidgetSpec,
  displayEntry,
  newId,
  type Board,
  type EventName,
  type EventPayload,
  type Proposal,
  type Quote,
  type RunKind,
  type RunTraceStep,
  type Widget,
  type WidgetDraft,
  type WidgetProfile,
  type WidgetResult,
  type WidgetRunJob,
} from '@app/contracts';
import {
  HttpError,
  busFromConfig,
  clientFromEnv,
  createLogger,
  createQueue,
  followAccountDeletes,
  logEntry,
  now,
  type AccountData,
  type Bus,
  type Call,
  type Handlers,
} from '@app/service-kit';
import postgres from 'postgres';
import {
  checkRefresh,
  checkWidgetCap,
  allMarketIds,
  applyTune,
  keptPlanProfile,
  tunedProfile,
  checkResult,
  defaultProfile,
  fetchQuotes,
  movementFlag,
  baselineOf,
  isAway,
  sinceOf,
  VISIT_GAP_S,
  packPlaces,
  planFolder,
  quotesFor,
  refreshKind,
  runJob,
  screenshotKey,
  sha256,
  validateDisplay,
  validateTune,
  view,
  ownConnection,
  type DisplaySpec,
} from './logic.ts';
import { draftsFor, folderTitleFor, prescribedTiles } from './defaults.ts';
import { s3ObjectStoreFromConfig } from './s3-store.ts';
import { LocalDirObjectStore, isPng, type ObjectStore } from './storage.ts';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Q = Sql | Tx;

export interface RealDeps {
  sql: Sql;
  bus: Bus;
  /** Puts a run on widget-runs. */
  enqueue: (queue: string, job: WidgetRunJob) => Promise<void>;
  /** markets, for first paint. */
  markets?: Call;
  /** connections, to check a "Your account" link is the account's own connection. */
  connections?: Call;
  objects: ObjectStore;
  /** A visit's gap, in seconds (default VISIT_GAP_S; BOARD_VISIT_GAP_S). */
  visitGapS?: number;
}

/**
 * From env: BOARD_DATABASE_URL, BOARD_VALKEY_URL, BOARD_TOKEN_MARKETS / BOARD_URL_MARKETS, BOARD_TOKEN_CONNECTIONS / BOARD_URL_CONNECTIONS, and where screenshots go:
 * BOARD_S3_BUCKET (+ _ENDPOINT, _REGION, _CREDENTIALS_FILE) for Object Storage, else BOARD_SCREENSHOT_DIR (dev, fallback).
 * BOARD_VISIT_GAP_S (optional): the gap between reads that starts a new visit, for "since you last looked".
 */
export async function real(cfg: Record<string, unknown>): Promise<Handlers<typeof BOARD>> {
  const url = cfg.DATABASE_URL;
  if (typeof url !== 'string' || !url) throw new Error('board: BOARD_DATABASE_URL is required in real mode');
  const valkey = typeof cfg.VALKEY_URL === 'string' ? cfg.VALKEY_URL : undefined;
  const bus = busFromConfig('board', { VALKEY_URL: valkey });
  const runs = createQueue(QUEUES.widgetRuns, valkey!, 'board');
  const log = createLogger('board');
  const dir = typeof cfg.SCREENSHOT_DIR === 'string' && cfg.SCREENSHOT_DIR ? cfg.SCREENSHOT_DIR : resolve('.data/board/screenshots');
  const s3 = s3ObjectStoreFromConfig(cfg);
  if (s3) log.info({ objects: 's3' }, 'screenshots in Object Storage');
  else log.info({ objects: 'local' }, 'screenshots in a local folder (no BOARD_S3_BUCKET)');
  const sql = connect(url);
  // A deleted account (the nightly guest sweep) takes its board with it; the orphan sweep catches a missed event.
  if (valkey) await followAccountDeletes({ service: 'board', bus, data: pgAccountData(sql), accounts: await clientFromEnv('board', 'accounts'), log });
  return createReal({
    sql,
    bus,
    enqueue: async (_q, job) => void (await runs.enqueue(job)),
    markets: await clientFromEnv('board', 'markets'),
    connections: await clientFromEnv('board', 'connections'),
    objects: s3 ?? new LocalDirObjectStore(dir),
    ...(Number(cfg.VISIT_GAP_S) > 0 ? { visitGapS: Number(cfg.VISIT_GAP_S) } : {}),
  });
}

/**
 * board's rows per account, for account deletion. The layout goes first (a tile's folder_id reference doesn't
 * cascade), then the board row, which cascades to widgets, results, proposals, run requests and screenshot rows
 * (migrations/0002_board.sql).
 */
export function pgAccountData(sql: Sql): AccountData {
  return {
    accountIds: async () => (await sql<{ account_id: string }[]>`select account_id from boards`).map((r) => r.account_id),
    forget: (account_id) =>
      sql.begin(async (tx) => {
        await tx`delete from layout where account_id = ${account_id}`;
        return (await tx`delete from boards where account_id = ${account_id} returning account_id`).length;
      }),
  };
}

/** svc_board's pool. The role is limited to 5 connections; migrations use one at start. */
export const connect = (url: string) =>
  postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: 'board', application_name: 'board' } });

type WidgetRow = {
  widget_id: string;
  account_id: string;
  kind: Widget['spec']['kind'];
  spec: Record<string, unknown>;
  profile: WidgetProfile | null;
  state: Widget['state'];
  quotes: Quote[] | null;
  updated_at: Date;
  col: number | null;
  row: number | null;
  folder_id: string | null;
  idx: number | null;
};
type ResultRow = { widget_id: string; slot: 'current' | 'previous' | 'seen' | 'baseline'; result: WidgetResult };
type ProposalRow = { proposal_id: string; account_id: string; status: Proposal['status']; changes: Proposal['changes']; created_at: Date };
type DisplayTile = Pick<WidgetDraft, 'type' | 'size' | 'title' | 'market_ids' | 'params'> & { brief?: string };
type Size = keyof typeof SIZE_CELLS;

const iso = (d: Date) => d.toISOString();
const placeOf = (r: WidgetRow): Widget['spec']['place'] =>
  r.folder_id !== null ? { folder_id: r.folder_id, index: r.idx! } : { col: r.col!, row: r.row! };
const toProposal = (r: ProposalRow): Proposal => ({ proposal_id: r.proposal_id, account_id: r.account_id, status: r.status, changes: r.changes, created_at: iso(r.created_at) });
const cellsOf = (kind: string, spec: Record<string, unknown>) => (kind === 'display' ? SIZE_CELLS[spec.size as Size] : ([1, 1] as const));

/**
 * Postgres rows -> the contract's Widget. Children of a folder come from the layout, in slot order. `away` (getWidget
 * only): whether the owner is between visits, which picks the baseline runner measures the since moves from.
 */
function assemble(rows: WidgetRow[], results: ResultRow[], away?: boolean): Widget[] {
  const byWidget = new Map<string, Partial<Record<ResultRow['slot'], WidgetResult>>>();
  for (const r of results) {
    const e = byWidget.get(r.widget_id) ?? {};
    e[r.slot] = r.result;
    byWidget.set(r.widget_id, e);
  }
  return rows.map((r) => {
    const base = { ...r.spec, widget_id: r.widget_id, account_id: r.account_id, kind: r.kind, place: placeOf(r) };
    const children = rows.filter((c) => c.folder_id === r.widget_id).sort((a, b) => a.idx! - b.idx!).map((c) => c.widget_id);
    const spec = WidgetSpec.parse(r.kind === 'folder' ? { ...base, children } : base);
    const res = byWidget.get(r.widget_id);
    const result = res?.current ?? null;
    const w: Widget = { spec, profile: r.profile, state: r.state, result, previous: res?.previous ?? null, since: sinceOf(result, res?.baseline ?? null), updated_at: iso(r.updated_at) };
    if (away !== undefined) w.baseline = baselineOf(away, res?.seen, res?.baseline);
    if (r.quotes?.length) w.quotes = r.quotes;
    return view(w);
  });
}

export function createReal(deps: RealDeps): Handlers<typeof BOARD> {
  const { sql, bus, objects } = deps;
  const visitGapS = deps.visitGapS ?? VISIT_GAP_S;

  // ---------- reads ----------
  const widgetRows = (q: Q, account_id: string) =>
    q<WidgetRow[]>`select w.widget_id, w.account_id, w.kind, w.spec, w.profile, w.state, w.quotes, w.updated_at,
                          l.col, l."row", l.folder_id, l.idx
                   from widgets w join layout l using (widget_id)
                   where w.account_id = ${account_id} order by w.seq`;

  async function loadBoard(account_id: string, q: Q = sql): Promise<Board> {
    const [b] = await q`select 1 from boards where account_id = ${account_id}`;
    if (!b) throw new HttpError(404, 'not_found', 'no board for this account');
    const [rows, results, pending] = await Promise.all([
      widgetRows(q, account_id),
      q<ResultRow[]>`select widget_id, slot, result from results where account_id = ${account_id}`,
      q<ProposalRow[]>`select * from proposals where account_id = ${account_id} and status = 'pending' order by created_at`,
    ]);
    return { account_id, widgets: assemble(rows, results), pending: pending.map(toProposal) };
  }

  async function loadWidget(widget_id: string, account_id: string, q: Q = sql, withBaseline = false): Promise<Widget> {
    const rows = await q<WidgetRow[]>`select w.widget_id, w.account_id, w.kind, w.spec, w.profile, w.state, w.quotes, w.updated_at,
                                             l.col, l."row", l.folder_id, l.idx
                                      from widgets w join layout l using (widget_id)
                                      where w.account_id = ${account_id} and (w.widget_id = ${widget_id} or l.folder_id = ${widget_id})`;
    if (!rows.some((r) => r.widget_id === widget_id)) throw new HttpError(404, 'not_found', 'no such widget');
    const results = await q<ResultRow[]>`select widget_id, slot, result from results where widget_id = ${widget_id} and account_id = ${account_id}`;
    let away: boolean | undefined;
    if (withBaseline) {
      const [b] = await q<{ last_opened_at: Date | null }[]>`select last_opened_at from boards where account_id = ${account_id}`;
      away = isAway(b?.last_opened_at, visitGapS);
    }
    return assemble(rows, results, away).find((w) => w.spec.widget_id === widget_id)!;
  }

  /** The spec as stored, locked for update inside a transaction. */
  async function lockSpec(tx: Tx, widget_id: string, account_id: string) {
    const [r] = await tx<WidgetRow[]>`select w.widget_id, w.account_id, w.kind, w.spec, w.profile, w.state, w.quotes, w.updated_at,
                                             l.col, l."row", l.folder_id, l.idx
                                      from widgets w join layout l using (widget_id)
                                      where w.widget_id = ${widget_id} and w.account_id = ${account_id} for update of w`;
    if (!r) return null;
    const spec = WidgetSpec.parse({ ...r.spec, widget_id, account_id, kind: r.kind, place: placeOf(r), ...(r.kind === 'folder' && { children: [] }) });
    return { row: r, spec };
  }

  async function nextRow(q: Q, account_id: string) {
    const rows = await widgetRows(q, account_id);
    return rows.reduce((m, r) => (r.row === null ? m : Math.max(m, r.row + cellsOf(r.kind, r.spec)[1])), 0);
  }

  // ---------- writes ----------
  /** What the spec column holds: no place (layout has it) and no children (derived from layout). */
  const stored = (spec: WidgetSpec): Record<string, unknown> => {
    const { place: _p, ...rest } = spec;
    if (rest.kind !== 'folder') return rest;
    const { children: _c, ...f } = rest;
    return f;
  };
  const json = (tx: Q, v: unknown) => tx.json(v as never);

  async function setPlace(tx: Tx, widget_id: string, account_id: string, place: Widget['spec']['place'], insert = false) {
    const p = 'folder_id' in place
      ? { col: null, row: null, folder_id: place.folder_id, idx: place.index }
      : { col: place.col, row: place.row, folder_id: null, idx: null };
    if (insert)
      await tx`insert into layout (widget_id, account_id, col, "row", folder_id, idx)
               values (${widget_id}, ${account_id}, ${p.col}, ${p.row}, ${p.folder_id}, ${p.idx})`;
    else
      await tx`update layout set col = ${p.col}, "row" = ${p.row}, folder_id = ${p.folder_id}, idx = ${p.idx}
               where widget_id = ${widget_id} and account_id = ${account_id}`;
  }
  async function insertWidget(tx: Tx, spec: WidgetSpec, profile: WidgetProfile | null, state: Widget['state'], quotes: Quote[] | null) {
    await tx`insert into widgets (widget_id, account_id, kind, spec, profile, state, quotes)
             values (${spec.widget_id}, ${spec.account_id}, ${spec.kind}, ${json(tx, stored(spec))},
                     ${profile ? json(tx, profile) : null}, ${state}, ${quotes?.length ? json(tx, quotes) : null})`;
    await setPlace(tx, spec.widget_id, spec.account_id, spec.place, true);
  }

  /** After commit: runs to the queue, events to the bus. A failure here doesn't undo the write (events are hints). */
  type Ev = { [E in EventName]: { event: E; payload: EventPayload<E> } }[EventName];
  type Out = { jobs: WidgetRunJob[]; events: Ev[] };
  const outbox = (): Out => ({ jobs: [], events: [] });
  async function flush(o: Out) {
    for (const j of o.jobs) await deps.enqueue(QUEUES.widgetRuns, j);
    for (const e of o.events) await bus.emit(e.event, e.payload as never);
  }
  const changed = (o: Out, account_id: string, widget_id: string, change: EventPayload<'widget.updated'>['change']) =>
    o.events.push({ event: 'widget.updated', payload: { account_id, at: now(), widget_id, change } });

  /**
   * Records the run in run_requests; queues it only when new. The same job id in the same minute joins the run
   * already asked for (`joined`), so a refresh right after a run can say "Updated just now" instead of nothing.
   */
  async function run(tx: Tx, o: Out, spec: DisplaySpec, kind: RunKind, reason: WidgetRunJob['reason']) {
    const job = runJob(spec, kind, reason);
    const [r] = await tx`insert into run_requests (job_id, widget_id, account_id, kind, reason, window_start)
                         values (${job.job_id}, ${job.widget_id}, ${job.account_id}, ${job.kind}, ${job.reason}, ${job.window_start})
                         on conflict (job_id) do nothing returning job_id`;
    if (r) o.jobs.push(job);
    return { job_id: job.job_id, joined: !r };
  }

  async function addDisplay(tx: Tx, o: Out, account_id: string, d: DisplayTile, place: Widget['spec']['place'], state: Widget['state'], quotes: Map<string, Quote>) {
    validateDisplay(d);
    const widget_id = newId('wid');
    const spec = WidgetSpec.parse({
      widget_id, account_id, kind: 'display', type: d.type, size: d.size ?? displayEntry(d.type).default_size,
      title: d.title, market_ids: d.market_ids, params: d.params, place,
    }) as DisplaySpec;
    await insertWidget(tx, spec, defaultProfile(widget_id, d.type, d.brief ?? ''), state, quotesFor(spec, quotes));
    changed(o, account_id, widget_id, 'added');
    return spec;
  }

  /** Removing a folder puts its tiles back on the grid, below the rest. Its rows cascade (results, runs, screenshots). */
  async function removeWidget(tx: Tx, o: Out, account_id: string, widget_id: string) {
    const kids = await tx<{ widget_id: string; kind: string; spec: Record<string, unknown> }[]>`
      select w.widget_id, w.kind, w.spec from widgets w join layout l using (widget_id)
      where l.folder_id = ${widget_id} and w.account_id = ${account_id} order by l.idx`;
    if (kids.length) {
      const places = packPlaces(kids.map((k) => cellsOf(k.kind, k.spec)), await nextRow(tx, account_id));
      for (const [i, k] of kids.entries()) {
        await setPlace(tx, k.widget_id, account_id, places[i]!);
        changed(o, account_id, k.widget_id, 'changed');
      }
    }
    await tx`delete from widgets where widget_id = ${widget_id} and account_id = ${account_id}`;
    changed(o, account_id, widget_id, 'removed');
  }

  /**
   * The owner read the board: `seen` becomes what is current now. A read after the visit gap starts a new visit, and the
   * last visit's `seen` becomes the `baseline` the strip compares with.
   */
  async function opened(account_id: string) {
    await sql.begin(async (tx) => {
      // board's own clock (as in isAway), so a visit's gap and the minute between writes are measured the same way.
      const at = Date.now();
      const [b] = await tx<{ last_opened_at: Date | null }[]>`select last_opened_at from boards where account_id = ${account_id} for update`;
      if (!b || (b.last_opened_at && at - b.last_opened_at.getTime() < Math.min(60, visitGapS) * 1000)) return;
      if (isAway(b.last_opened_at, visitGapS, at)) {
        await tx`delete from results where account_id = ${account_id} and slot = 'baseline'`;
        await tx`update results set slot = 'baseline' where account_id = ${account_id} and slot = 'seen'`;
      } else await tx`delete from results where account_id = ${account_id} and slot = 'seen'`;
      await tx`insert into results (widget_id, account_id, slot, result_id, run_id, kind, phase, result, verdict, trace, stored_at)
               select widget_id, account_id, 'seen', result_id, run_id, kind, phase, result, verdict, trace, stored_at
               from results where account_id = ${account_id} and slot = 'current'`;
      await tx`update boards set last_opened_at = ${new Date(at)} where account_id = ${account_id}`;
    });
  }

  const audit = (action: string, rest: Parameters<typeof logEntry>[2]) => bus.log(logEntry('board', action, rest)).catch(() => {});

  return {
    getBoard: async ({ params }, ctx) => {
      // Read by its owner (edge serves only the session's own board): runner's scheduler keeps this board's runs going,
      // and "since you last looked" keeps its visits. At most one write a minute per board.
      if (ctx.caller === 'edge') await opened(params.account_id);
      return loadBoard(params.account_id);
    },

    lastOpened: async ({ body }) => {
      const rows = await sql<{ account_id: string; last_opened_at: Date | null }[]>`
        select account_id, last_opened_at from boards where account_id = any(${[...new Set(body.account_ids)]})`;
      return { boards: rows.map((r) => ({ account_id: r.account_id, last_opened_at: r.last_opened_at ? r.last_opened_at.toISOString() : null })) };
    },

    createDefaults: async ({ params }, ctx) => {
      const account_id = params.account_id;
      const tiles = await prescribedTiles(deps.markets, Date.now());
      const displays = tiles.flatMap((t) => (t.kind === 'display' ? [t] : t.kind === 'folder' ? t.children : []));
      const [exists] = await sql`select 1 from boards where account_id = ${account_id}`;
      if (exists) throw new HttpError(409, 'exists', 'board already exists');
      // First paint: cached prices before any run (markets caches them 10-30 s, shared by every follower).
      const quotes = await fetchQuotes(deps.markets, allMarketIds(displays));
      const wanted = new Set(allMarketIds(displays)).size;
      if (quotes.size < wanted) ctx.log.warn({ wanted, got: quotes.size }, 'first paint: markets gave fewer prices than asked');
      const o = outbox();
      await sql.begin(async (tx) => {
        const [b] = await tx`insert into boards (account_id, category) values (${account_id}, 'sports') on conflict do nothing returning account_id`;
        if (!b) throw new HttpError(409, 'exists', 'board already exists');
        const places = packPlaces(tiles.map((t) => (t.kind === 'display' ? SIZE_CELLS[t.size] : [1, 1])));
        for (const [i, t] of tiles.entries()) {
          const place = places[i]!;
          if (t.kind === 'display') {
            await run(tx, o, await addDisplay(tx, o, account_id, t, place, 'normal', quotes), 'numbers', 'accept');
          } else if (t.kind === 'app') {
            await insertWidget(tx, { widget_id: newId('wid'), account_id, kind: 'app', app: t.app, title: t.title, place }, null, 'normal', null);
          } else {
            const folder_id = newId('wid');
            await insertWidget(tx, { widget_id: folder_id, account_id, kind: 'folder', title: t.title, children: [], place }, null, 'normal', null);
            for (const [index, child] of t.children.entries())
              await run(tx, o, await addDisplay(tx, o, account_id, child, { folder_id, index }, 'normal', quotes), 'numbers', 'accept');
          }
        }
      });
      await flush(o);
      await audit('board.created', { account_id, subject_id: account_id, outcome: 'ok', sizes: { tiles: tiles.length, quotes: quotes.size } });
      return loadBoard(account_id);
    },

    setLayout: async ({ params, body }) => {
      const account_id = params.account_id;
      const o = outbox();
      await sql.begin(async (tx) => {
        const [b] = await tx`select 1 from boards where account_id = ${account_id} for update`;
        if (!b) throw new HttpError(404, 'not_found', 'no board for this account');
        const rows = new Map((await widgetRows(tx, account_id)).map((r) => [r.widget_id, r]));
        for (const { widget_id, place } of body.places) {
          const w = rows.get(widget_id);
          if (!w) throw new HttpError(404, 'not_found', 'no such widget');
          if ('folder_id' in place) {
            const f = rows.get(place.folder_id);
            if (!f || f.kind !== 'folder' || w.kind === 'folder')
              throw new HttpError(400, 'bad_folder', "a tile can go only into a folder on the same board, and folders don't nest");
          }
        }
        for (const { widget_id, place } of body.places) {
          await setPlace(tx, widget_id, account_id, place);
          changed(o, account_id, widget_id, 'changed');
        }
      });
      await flush(o);
      return loadBoard(account_id);
    },

    makeFolder: async ({ params, body }) => {
      const account_id = params.account_id;
      const o = outbox();
      const folder_id = newId('wid');
      // The default title asks markets for this week's games: before the transaction, so no lock waits on it. Displays
      // only: an app or a folder in the list has no params, and the transaction refuses that list with a 400.
      const picked = body.title ? [] : (await widgetRows(sql, account_id)).filter((r) => r.kind === 'display' && body.widget_ids.includes(r.widget_id));
      const title = body.title ?? (await folderTitleFor(deps.markets, picked.map((r) => r.spec as { params: { event_keys?: string[] } }), Date.now()));
      await sql.begin(async (tx) => {
        const [b] = await tx`select 1 from boards where account_id = ${account_id} for update`;
        if (!b) throw new HttpError(404, 'not_found', 'no board for this account');
        const rows = await widgetRows(tx, account_id);
        const below = await nextRow(tx, account_id);
        const tiles = new Map(rows.map((r) => [r.widget_id, { widget_id: r.widget_id, kind: r.kind, place: placeOf(r) }]));
        const plan = planFolder(tiles, body.widget_ids, body.place, () => ({ col: 0, row: below }));
        await insertWidget(tx, { widget_id: folder_id, account_id, kind: 'folder', title, children: [], place: plan.place }, null, 'normal', null);
        for (const [index, id] of body.widget_ids.entries()) {
          await setPlace(tx, id, account_id, { folder_id, index });
          changed(o, account_id, id, 'changed');
        }
        for (const f of plan.emptied) await removeWidget(tx, o, account_id, f);
        changed(o, account_id, folder_id, 'added');
      });
      await flush(o);
      return loadBoard(account_id);
    },

    setTitle: async ({ params, body }) => {
      const { account_id, widget_id } = params;
      const o = outbox();
      await sql.begin(async (tx) => {
        const l = await lockSpec(tx, widget_id, account_id);
        if (!l) throw new HttpError(404, 'not_found', 'no such widget');
        if (l.spec.kind !== 'folder') throw new HttpError(400, 'not_folder', 'only a folder can be renamed');
        await tx`update widgets set spec = ${json(tx, stored({ ...l.spec, title: body.title }))}, updated_at = now()
                 where widget_id = ${widget_id} and account_id = ${account_id}`;
        changed(o, account_id, widget_id, 'changed');
      });
      await flush(o);
      return loadWidget(widget_id, account_id);
    },

    propose: async ({ params, body }) => {
      const account_id = params.account_id;
      const [b] = await sql`select 1 from boards where account_id = ${account_id}`;
      if (!b) throw new HttpError(404, 'not_found', 'no board for this account');
      const o = outbox();
      for (const c of body.changes) {
        if (c.op === 'add') {
          validateDisplay(c.widget);
          continue;
        }
        const w = await loadWidget(c.widget_id, account_id);
        if (c.op === 'tune') validateTune(c, w.spec);
        changed(o, account_id, c.widget_id, 'pending');
      }
      const [r] = await sql<ProposalRow[]>`insert into proposals (proposal_id, account_id, status, changes)
                                           values (${newId('prp')}, ${account_id}, 'pending', ${json(sql, body.changes)}) returning *`;
      await flush(o);
      await audit('proposal.created', { account_id, subject_id: r!.proposal_id, outcome: 'ok', sizes: { changes: body.changes.length } });
      return toProposal(r!);
    },

    accept: async ({ params, body }) => {
      const account_id = body.account_id;
      const o = outbox();
      const touched: string[] = [];
      // First paint for the new widgets: prices fetched before the transaction, so no lock waits on markets.
      const [pre] = await sql<ProposalRow[]>`select * from proposals where proposal_id = ${params.proposal_id} and account_id = ${account_id}`;
      const quotes = await fetchQuotes(deps.markets, allMarketIds((pre?.changes ?? []).flatMap((c) => (c.op === 'add' ? [c.widget] : []))));
      const proposal = await sql.begin(async (tx) => {
        const [p] = await tx<ProposalRow[]>`select * from proposals where proposal_id = ${params.proposal_id} and account_id = ${account_id} for update`;
        if (!p) throw new HttpError(404, 'not_found', 'no such proposal');
        if (p.status !== 'pending') throw new HttpError(409, 'not_pending', `proposal is ${p.status}`);
        await tx`select 1 from boards where account_id = ${account_id} for update`;
        const drafts = p.changes.flatMap((c) => (c.op === 'add' ? [c.widget] : []));
        const [have] = await tx<{ n: number }[]>`select count(*)::int as n from widgets where account_id = ${account_id}`;
        checkWidgetCap(have!.n, drafts.length);
        const places = packPlaces(drafts.map((d) => SIZE_CELLS[d.size ?? displayEntry(d.type).default_size]), await nextRow(tx, account_id));
        let i = 0;
        for (const c of p.changes) {
          if (c.op === 'add') {
            const spec = await addDisplay(tx, o, account_id, c.widget, places[i++]!, 'new', quotes);
            await run(tx, o, spec, 'numbers', 'accept');
            if (displayEntry(spec.type).research) await run(tx, o, spec, 'research', 'accept');
            touched.push(spec.widget_id);
            continue;
          }
          const locked = await lockSpec(tx, c.widget_id, account_id);
          if (!locked) throw new HttpError(409, 'stale', 'a widget in this proposal is gone');
          if (c.op === 'tune') {
            validateTune(c, locked.spec);
            const spec = locked.spec.kind === 'display' ? applyTune(c, locked.spec) : locked.spec;
            const profile = locked.row.profile ? tunedProfile(c, locked.row.profile) : null;
            await tx`update widgets set spec = ${json(tx, stored(spec))}, profile = ${profile ? json(tx, profile) : null}, updated_at = now()
                     where widget_id = ${c.widget_id} and account_id = ${account_id}`;
            changed(o, account_id, c.widget_id, 'changed');
            touched.push(c.widget_id);
          } else {
            await removeWidget(tx, o, account_id, c.widget_id);
          }
        }
        const [done] = await tx<ProposalRow[]>`update proposals set status = 'accepted', decided_at = now() where proposal_id = ${p.proposal_id} returning *`;
        return toProposal(done!);
      });
      await flush(o);
      await audit('proposal.accepted', { account_id, subject_id: proposal.proposal_id, outcome: 'ok', sizes: { widgets: touched.length, runs: o.jobs.length } });
      const widgets = await Promise.all(touched.map((id) => loadWidget(id, account_id)));
      return { proposal, widgets };
    },

    reject: async ({ params, body }) => {
      const [r] = await sql<ProposalRow[]>`update proposals set status = 'rejected', decided_at = now()
                                           where proposal_id = ${params.proposal_id} and account_id = ${body.account_id} and status = 'pending' returning *`;
      if (r) {
        await audit('proposal.rejected', { account_id: body.account_id, subject_id: r.proposal_id, outcome: 'ok' });
        return toProposal(r);
      }
      const [p] = await sql<ProposalRow[]>`select * from proposals where proposal_id = ${params.proposal_id} and account_id = ${body.account_id}`;
      if (!p) throw new HttpError(404, 'not_found', 'no such proposal');
      throw new HttpError(409, 'not_pending', `proposal is ${p.status}`);
    },

    getWidget: ({ params, query }) => loadWidget(params.widget_id, query.account_id, sql, true),

    resize: async ({ params, body }) => {
      const o = outbox();
      await sql.begin(async (tx) => {
        const l = await lockSpec(tx, params.widget_id, body.account_id);
        if (!l) throw new HttpError(404, 'not_found', 'no such widget');
        if (l.spec.kind !== 'display' || !displayEntry(l.spec.type).sizes.includes(body.size))
          throw new HttpError(400, 'bad_size', 'that size is not in the catalog for this widget');
        await tx`update widgets set spec = ${json(tx, stored({ ...l.spec, size: body.size }))}, updated_at = now()
                 where widget_id = ${params.widget_id} and account_id = ${body.account_id}`;
        changed(o, body.account_id, params.widget_id, 'changed');
      });
      await flush(o);
      return loadWidget(params.widget_id, body.account_id);
    },

    clear: async ({ params, body }) => {
      const o = outbox();
      await sql.begin(async (tx) => {
        const l = await lockSpec(tx, params.widget_id, body.account_id);
        if (!l) throw new HttpError(404, 'not_found', 'no such widget');
        if (l.spec.kind === 'display') {
          await tx`update widgets set profile = ${json(tx, defaultProfile(l.spec.widget_id, l.spec.type))}, updated_at = now()
                   where widget_id = ${params.widget_id} and account_id = ${body.account_id}`;
          await run(tx, o, l.spec, refreshKind(l.spec), 'clear');
        }
        changed(o, body.account_id, params.widget_id, 'cleared');
      });
      await flush(o);
      return loadWidget(params.widget_id, body.account_id);
    },

    remove: async ({ params, query }) => {
      const o = outbox();
      await sql.begin(async (tx) => {
        const l = await lockSpec(tx, params.widget_id, query.account_id);
        if (!l) throw new HttpError(404, 'not_found', 'no such widget');
        await removeWidget(tx, o, query.account_id, params.widget_id);
      });
      await flush(o);
      await audit('widget.removed', { account_id: query.account_id, subject_id: params.widget_id, outcome: 'ok' });
      return { ok: true as const };
    },

    refresh: async ({ params, body }) => {
      const o = outbox();
      const r = await sql.begin(async (tx) => {
        const l = await lockSpec(tx, params.widget_id, body.account_id);
        if (!l || l.spec.kind !== 'display') throw new HttpError(404, 'not_found', 'only displays refresh');
        // A refresh that joins this minute's run costs nothing: it is never counted, nor refused.
        const kind = refreshKind(l.spec);
        const { job_id } = runJob(l.spec, kind, 'refresh');
        const [had] = await tx`select 1 from run_requests where job_id = ${job_id}`;
        if (had) return { job_id, joined: true };
        // One account's refreshes count one at a time, so two widgets refreshed together can't both pass at 59.
        await tx`select pg_advisory_xact_lock(hashtext(${'refresh:' + body.account_id}))`;
        const [c] = await tx<{ widget: number; account: number }[]>`
          select count(*) filter (where widget_id = ${params.widget_id})::int as widget, count(*)::int as account
          from run_requests where account_id = ${body.account_id} and reason = 'refresh' and requested_at > now() - interval '1 hour'`;
        checkRefresh(c!.widget, c!.account);
        return run(tx, o, l.spec, kind, 'refresh');
      });
      await flush(o);
      return r;
    },

    setConnection: async ({ params, body }) => {
      await ownConnection(deps.connections, body.account_id, body.connection_id);
      const o = outbox();
      await sql.begin(async (tx) => {
        const l = await lockSpec(tx, params.widget_id, body.account_id);
        if (!l) throw new HttpError(404, 'not_found', 'no such widget');
        if (l.spec.kind !== 'display' || l.spec.type !== 'positions')
          throw new HttpError(400, 'not_positions', 'only a "Your account" display shows a connected account');
        const spec: DisplaySpec = { ...l.spec, params: { ...l.spec.params, connection_id: body.connection_id } };
        await tx`update widgets set spec = ${json(tx, stored(spec))}, updated_at = now()
                 where widget_id = ${params.widget_id} and account_id = ${body.account_id}`;
        await run(tx, o, spec, 'numbers', 'accept');
        changed(o, body.account_id, params.widget_id, 'changed');
      });
      await flush(o);
      return loadWidget(params.widget_id, body.account_id);
    },

    addSource: async ({ params, body }) => {
      const o = outbox();
      await sql.begin(async (tx) => {
        const l = await lockSpec(tx, params.widget_id, body.account_id);
        if (!l) throw new HttpError(404, 'not_found', 'no such widget');
        const p = l.row.profile;
        if (!p) throw new HttpError(400, 'no_profile', 'apps and folders have no sources');
        if (p.added_domains.includes(body.domain)) return;
        if (p.added_domains.length >= 20) throw new HttpError(400, 'too_many_sources', 'at most 20 added domains');
        await tx`update widgets set profile = ${json(tx, { ...p, added_domains: [...p.added_domains, body.domain] })}, updated_at = now()
                 where widget_id = ${params.widget_id} and account_id = ${body.account_id}`;
        changed(o, body.account_id, params.widget_id, 'changed');
      });
      await flush(o);
      return loadWidget(params.widget_id, body.account_id);
    },

    putResult: async ({ params, body }) => {
      const { account_id, result } = body;
      const widget_id = params.widget_id;
      const o = outbox();
      await sql.begin(async (tx) => {
        const l = await lockSpec(tx, widget_id, account_id);
        if (!l) throw new HttpError(404, 'not_found', 'no such widget');
        try {
          checkResult(body, l.spec);
        } catch (e) {
          await audit('result.refused', { account_id, subject_id: widget_id, outcome: 'refused', ids: { run_id: result.run_id, verdict_id: body.verdict.verdict_id } });
          throw e;
        }
        // A new run moves the current result to "previous"; the summary phase of the same run replaces "current".
        await tx`delete from results where widget_id = ${widget_id} and slot = 'previous'
                 and exists (select 1 from results c where c.widget_id = ${widget_id} and c.slot = 'current' and c.run_id <> ${result.run_id})`;
        await tx`update results set slot = 'previous' where widget_id = ${widget_id} and slot = 'current' and run_id <> ${result.run_id}`;
        await tx`insert into results (widget_id, account_id, slot, result_id, run_id, kind, phase, result, verdict, trace)
                 values (${widget_id}, ${account_id}, 'current', ${result.result_id}, ${result.run_id}, ${result.kind}, ${body.phase},
                         ${json(tx, result)}, ${json(tx, body.verdict)}, ${json(tx, body.trace)})
                 on conflict (widget_id, slot) do update set result_id = excluded.result_id, run_id = excluded.run_id, kind = excluded.kind,
                   phase = excluded.phase, result = excluded.result, verdict = excluded.verdict, trace = excluded.trace, stored_at = now()`;
        await tx`update widgets set state = ${result.blocked.length ? 'blocked' : 'normal'}, quotes = null, updated_at = now()
                 where widget_id = ${widget_id} and account_id = ${account_id}`;
        const kept = keptPlanProfile(l.row.profile, body.math_plan);
        if (kept) await tx`update widgets set profile = ${json(tx, kept)} where widget_id = ${widget_id} and account_id = ${account_id}`;
        o.events.push({ event: 'result.updated', payload: { account_id, at: now(), widget_id, result_id: result.result_id, phase: body.phase } });
        const flag = movementFlag(l.spec, result);
        if (!flag) return;
        o.events.push({ event: 'movement.flagged', payload: { account_id, at: now(), widget_id, ...flag } });
        // A move past the threshold starts a research run for this account's widgets that read sources on that market.
        for (const r of await widgetRows(tx, account_id)) {
          if (r.kind !== 'display') continue;
          const spec = WidgetSpec.parse({ ...r.spec, place: placeOf(r) }) as DisplaySpec;
          if (displayEntry(spec.type).research && spec.market_ids.includes(flag.market_id)) await run(tx, o, spec, 'research', 'movement');
        }
      });
      await flush(o);
      await audit('result.stored', {
        account_id, subject_id: widget_id, outcome: 'ok',
        ids: { run_id: result.run_id, result_id: result.result_id, verdict_id: body.verdict.verdict_id },
        sizes: { numbers: result.numbers.length, receipts: result.receipts.length, facts: result.facts.length, blocked: result.blocked.length, trace: body.trace.length },
      });
      return { result_id: result.result_id };
    },

    getTrace: async ({ params, query }) => {
      await loadWidget(params.widget_id, query.account_id);
      const [r] = await sql<{ trace: RunTraceStep[] }[]>`select trace from results
                                                         where widget_id = ${params.widget_id} and account_id = ${query.account_id} and slot = 'current'`;
      return { steps: r?.trace ?? [] };
    },

    putScreenshot: async ({ params, body }) => {
      const [w] = await sql`select 1 from widgets where widget_id = ${params.widget_id} and account_id = ${body.account_id}`;
      if (!w) throw new HttpError(404, 'not_found', 'no such widget');
      const bytes = Buffer.from(body.png_base64, 'base64');
      if (!isPng(bytes)) throw new HttpError(400, 'not_png', 'a screenshot must be a PNG');
      const key = screenshotKey(params.widget_id, params.run_id, params.candidate_id);
      const hash = sha256(bytes);
      await objects.put(key, bytes, 'image/png');
      await sql`insert into screenshots (screenshot_key, widget_id, account_id, run_id, candidate_id, bytes, sha256)
                values (${key}, ${params.widget_id}, ${body.account_id}, ${params.run_id}, ${params.candidate_id}, ${bytes.length}, ${hash})
                on conflict (screenshot_key) do update set bytes = excluded.bytes, sha256 = excluded.sha256, stored_at = now()`;
      await audit('screenshot.stored', {
        account_id: body.account_id, subject_id: params.widget_id, outcome: 'ok',
        ids: { run_id: params.run_id, candidate_id: params.candidate_id }, hashes: { png: hash }, sizes: { bytes: bytes.length },
      });
      return { screenshot_key: key };
    },

    addDrafts: async ({ params }) => ({ drafts: await draftsFor(deps.markets, params.type, Date.now()) }),
    getScreenshot: async ({ params, query }) => {
      const key = screenshotKey(params.widget_id, params.run_id, params.candidate_id);
      const [r] = await sql<{ sha256: string }[]>`select sha256 from screenshots where screenshot_key = ${key} and account_id = ${query.account_id}`;
      if (!r) throw new HttpError(404, 'not_found', 'no such screenshot');
      const bytes = await objects.get(key);
      // The hash check catches a bucket object that was swapped or damaged after board stored it.
      if (!bytes || sha256(bytes) !== r.sha256) throw new HttpError(404, 'not_found', 'no such screenshot');
      return { screenshot_key: key, content_type: 'image/png' as const, png_base64: bytes.toString('base64') };
    },

    getReceipt: async ({ params, query }) => {
      const want = json(sql, [{ id: params.receipt_id }]);
      const rows = await sql<ResultRow[]>`select widget_id, slot, result from results
                                          where account_id = ${query.account_id}
                                            and (result -> 'receipts' @> ${want} or result -> 'since' -> 'receipts' @> ${want})
                                          order by slot`;
      for (const r of rows) {
        const found = [...r.result.receipts, ...(r.result.since?.receipts ?? [])].find((x) => x.id === params.receipt_id);
        if (found) return found;
      }
      throw new HttpError(404, 'not_found', 'no such receipt on this board');
    },
  };
}
