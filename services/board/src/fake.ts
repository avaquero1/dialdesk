import {
  BOARD,
  QUEUES,
  SIZE_CELLS,
  WIDGET_CATALOG,
  WidgetSpec,
  displayEntry,
  newId,
  type Board,
  type Proposal,
  type RunKind,
  type RunTraceStep,
  type Widget,
  type WidgetDraft,
  type WidgetRunJob,
} from '@app/contracts';
import { HttpError, MemoryBus, calleeConfig, createClient, now, type Bus, type Call, type Handlers } from '@app/service-kit';
import {
  REFRESH_PER_HOUR,
  allMarketIds,
  applyTune,
  checkResult,
  defaultProfile,
  fetchQuotes,
  movementFlag,
  packPlaces,
  quotesFor,
  refreshKind,
  runJob,
  screenshotKey,
  validateDisplay,
  validateTune,
  view,
  type DisplaySpec,
} from './logic.ts';
import { MemoryObjectStore, isPng, type ObjectStore } from './storage.ts';

export interface FakeDeps {
  bus?: Bus;
  /** Where enqueued runs go. Default: kept in memory (`fakeQueue`). */
  enqueue?: (queue: string, job: WidgetRunJob) => void | Promise<void>;
  /** markets, for first paint. Without it, new widgets have no quotes. */
  markets?: Call;
  /** Screenshots. Default: in memory. */
  objects?: ObjectStore;
}
/** With `make fakes`, the board fake reads first-paint prices from the markets fake over HTTP. */
export async function fakeDepsFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<FakeDeps> {
  const { token, url } = calleeConfig('board', 'markets', env);
  return token ? { markets: createClient({ baseUrl: url, token }) } : {};
}

/** Runs the fake enqueued, for tests to read (the real board uses BullMQ on QUEUES.widgetRuns). */
export const fakeQueue: WidgetRunJob[] = [];

type DisplayTile = Pick<WidgetDraft, 'type' | 'size' | 'title' | 'market_ids' | 'params'> & { brief?: string };

/** In-memory board: boards, widgets, proposals, results and traces. Validates every spec against the catalog. */
export function fake(deps: FakeDeps = {}): Handlers<typeof BOARD> {
  const bus = deps.bus ?? new MemoryBus();
  const enqueue = deps.enqueue ?? ((_q: string, j: WidgetRunJob) => void fakeQueue.push(j));
  const objects = deps.objects ?? new MemoryObjectStore();
  const boards = new Map<string, { widgets: string[]; pending: string[] }>();
  const widgets = new Map<string, Widget>();
  const proposals = new Map<string, Proposal>();
  const traces = new Map<string, RunTraceStep[]>();

  /** Folder children follow the places: a display whose place names a folder is in it. */
  const withChildren = (w: Widget, ids: string[]): Widget => {
    if (w.spec.kind !== 'folder') return w;
    const children = ids
      .map((id) => widgets.get(id)!)
      .filter((c) => c && 'folder_id' in c.spec.place && c.spec.place.folder_id === w.spec.widget_id)
      .sort((a, b) => ('index' in a.spec.place ? a.spec.place.index : 0) - ('index' in b.spec.place ? b.spec.place.index : 0))
      .map((c) => c.spec.widget_id);
    return { ...w, spec: { ...w.spec, children } };
  };
  const board = (account_id: string): Board => {
    const b = boards.get(account_id);
    if (!b) throw new HttpError(404, 'not_found', 'no board for this account');
    return {
      account_id,
      widgets: b.widgets.map((id) => widgets.get(id)!).filter(Boolean).map((w) => view(withChildren(w, b.widgets))),
      pending: b.pending.map((id) => proposals.get(id)!).filter((p) => p.status === 'pending'),
    };
  };
  const widget = (widget_id: string, account_id: string): Widget => {
    const w = widgets.get(widget_id);
    if (!w || w.spec.account_id !== account_id) throw new HttpError(404, 'not_found', 'no such widget');
    return w;
  };
  const shown = (w: Widget) => view(withChildren(w, boards.get(w.spec.account_id)?.widgets ?? []));
  const nextRow = (account_id: string) => {
    let max = -1;
    for (const id of boards.get(account_id)!.widgets) {
      const w = widgets.get(id)!;
      if ('row' in w.spec.place) {
        const h = w.spec.kind === 'display' ? SIZE_CELLS[w.spec.size][1] : 1;
        max = Math.max(max, w.spec.place.row + h - 1);
      }
    }
    return max + 1;
  };
  /** The same job id in the same minute collapses, as it does on the queue. */
  const requested = new Map<string, { at: number; reason: WidgetRunJob['reason']; widget_id: string }>();
  async function enqueueRun(spec: DisplaySpec, kind: RunKind, reason: WidgetRunJob['reason']) {
    const job = runJob(spec, kind, reason);
    if (requested.has(job.job_id)) return job.job_id;
    requested.set(job.job_id, { at: Date.now(), reason, widget_id: spec.widget_id });
    await enqueue(QUEUES.widgetRuns, job);
    return job.job_id;
  }
  async function addDisplay(account_id: string, d: DisplayTile, place: Widget['spec']['place'], state: Widget['state'], quotes: Widget['quotes']) {
    validateDisplay(d);
    const widget_id = newId('wid');
    const spec = WidgetSpec.parse({
      widget_id, account_id, kind: 'display', type: d.type, size: d.size ?? displayEntry(d.type).default_size,
      title: d.title, market_ids: d.market_ids, params: d.params, place,
    }) as DisplaySpec;
    const w: Widget = { spec, profile: defaultProfile(widget_id, d.type, d.brief ?? ''), state, result: null, previous: null, updated_at: now() };
    const q = quotesFor(spec, new Map((quotes ?? []).map((x) => [x.market_id, x])));
    if (q.length) w.quotes = q;
    widgets.set(widget_id, w);
    boards.get(account_id)!.widgets.push(widget_id);
    await bus.emit('widget.updated', { account_id, at: now(), widget_id, change: 'added' });
    return w;
  }
  const tile = (account_id: string, spec: Widget['spec']) => {
    widgets.set(spec.widget_id, { spec, profile: null, state: 'normal', result: null, previous: null, updated_at: now() });
    boards.get(account_id)!.widgets.push(spec.widget_id);
  };

  return {
    getBoard: ({ params }) => board(params.account_id),
    createDefaults: async ({ params }) => {
      const account_id = params.account_id;
      if (boards.has(account_id)) throw new HttpError(409, 'exists', 'board already exists');
      const tiles = WIDGET_CATALOG.default_board.tiles;
      const displays = tiles.flatMap((t) => (t.kind === 'display' ? [t] : t.kind === 'folder' ? t.children : []));
      const quotes = [...(await fetchQuotes(deps.markets, allMarketIds(displays))).values()];
      boards.set(account_id, { widgets: [], pending: [] });
      const places = packPlaces(tiles.map((t) => (t.kind === 'display' ? SIZE_CELLS[t.size] : [1, 1])));
      for (const [i, t] of tiles.entries()) {
        const place = places[i]!;
        if (t.kind === 'display') {
          const w = await addDisplay(account_id, t, place, 'normal', quotes);
          await enqueueRun(w.spec as DisplaySpec, 'numbers', 'accept');
        } else if (t.kind === 'app') {
          tile(account_id, { widget_id: newId('wid'), account_id, kind: 'app', app: t.app, title: t.title, place });
        } else {
          const folder_id = newId('wid');
          tile(account_id, { widget_id: folder_id, account_id, kind: 'folder', title: t.title, children: [], place });
          for (const [index, child] of t.children.entries()) {
            const w = await addDisplay(account_id, child, { folder_id, index }, 'normal', quotes);
            await enqueueRun(w.spec as DisplaySpec, 'numbers', 'accept');
          }
        }
      }
      return board(account_id);
    },
    setLayout: async ({ params, body }) => {
      const b = board(params.account_id);
      for (const { widget_id, place } of body.places) {
        const w = widget(widget_id, b.account_id);
        if ('folder_id' in place) {
          const f = widgets.get(place.folder_id);
          if (!f || f.spec.account_id !== b.account_id || f.spec.kind !== 'folder' || w.spec.kind === 'folder')
            throw new HttpError(400, 'bad_folder', "a tile can go only into a folder on the same board, and folders don't nest");
        }
      }
      for (const { widget_id, place } of body.places) {
        const w = widget(widget_id, b.account_id);
        w.spec = WidgetSpec.parse({ ...w.spec, place });
        await bus.emit('widget.updated', { account_id: b.account_id, at: now(), widget_id, change: 'changed' });
      }
      return board(params.account_id);
    },
    propose: async ({ params, body }) => {
      const b = boards.get(params.account_id);
      if (!b) throw new HttpError(404, 'not_found', 'no board for this account');
      for (const c of body.changes) {
        if (c.op === 'add') validateDisplay(c.widget);
        else if (c.op === 'tune') validateTune(c, widget(c.widget_id, params.account_id).spec);
        else widget(c.widget_id, params.account_id);
      }
      const p: Proposal = { proposal_id: newId('prp'), account_id: params.account_id, status: 'pending', changes: body.changes, created_at: now() };
      proposals.set(p.proposal_id, p);
      b.pending.push(p.proposal_id);
      return p;
    },
    accept: async ({ params, body }) => {
      const p = proposals.get(params.proposal_id);
      if (!p || p.account_id !== body.account_id) throw new HttpError(404, 'not_found', 'no such proposal');
      if (p.status !== 'pending') throw new HttpError(409, 'not_pending', `proposal is ${p.status}`);
      for (const c of p.changes) if (c.op !== 'add' && !widgets.has(c.widget_id)) throw new HttpError(409, 'stale', 'a widget in this proposal is gone');
      const adds = p.changes.flatMap((c) => (c.op === 'add' ? [c.widget] : []));
      const quotes = [...(await fetchQuotes(deps.markets, allMarketIds(adds))).values()];
      const places = packPlaces(adds.map((d) => SIZE_CELLS[d.size ?? displayEntry(d.type).default_size]), nextRow(p.account_id));
      const out: Widget[] = [];
      let i = 0;
      for (const c of p.changes) {
        if (c.op === 'add') {
          const w = await addDisplay(p.account_id, c.widget, places[i++]!, 'new', quotes);
          await enqueueRun(w.spec as DisplaySpec, 'numbers', 'accept');
          if (displayEntry(c.widget.type).research) await enqueueRun(w.spec as DisplaySpec, 'research', 'accept');
          out.push(shown(w));
        } else if (c.op === 'tune') {
          const w = widgets.get(c.widget_id)!;
          validateTune(c, w.spec);
          if (w.spec.kind === 'display') w.spec = applyTune(c, w.spec);
          if (w.profile && c.brief !== undefined) w.profile.brief = c.brief;
          w.updated_at = now();
          await bus.emit('widget.updated', { account_id: p.account_id, at: now(), widget_id: c.widget_id, change: 'changed' });
          out.push(shown(w));
        } else {
          removeWidget(p.account_id, c.widget_id);
          await bus.emit('widget.updated', { account_id: p.account_id, at: now(), widget_id: c.widget_id, change: 'removed' });
        }
      }
      p.status = 'accepted';
      return { proposal: p, widgets: out };
    },
    reject: ({ params, body }) => {
      const p = proposals.get(params.proposal_id);
      if (!p || p.account_id !== body.account_id) throw new HttpError(404, 'not_found', 'no such proposal');
      if (p.status !== 'pending') throw new HttpError(409, 'not_pending', `proposal is ${p.status}`);
      p.status = 'rejected';
      return p;
    },
    getWidget: ({ params, query }) => shown(widget(params.widget_id, query.account_id)),
    resize: async ({ params, body }) => {
      const w = widget(params.widget_id, body.account_id);
      if (w.spec.kind !== 'display' || !displayEntry(w.spec.type).sizes.includes(body.size))
        throw new HttpError(400, 'bad_size', 'that size is not in the catalog for this widget');
      w.spec = { ...w.spec, size: body.size };
      await bus.emit('widget.updated', { account_id: body.account_id, at: now(), widget_id: params.widget_id, change: 'changed' });
      return shown(w);
    },
    clear: async ({ params, body }) => {
      const w = widget(params.widget_id, body.account_id);
      if (w.spec.kind === 'display') {
        w.profile = defaultProfile(w.spec.widget_id, w.spec.type);
        await enqueueRun(w.spec, refreshKind(w.spec), 'clear');
      }
      await bus.emit('widget.updated', { account_id: body.account_id, at: now(), widget_id: params.widget_id, change: 'cleared' });
      return shown(w);
    },
    remove: async ({ params, query }) => {
      widget(params.widget_id, query.account_id);
      removeWidget(query.account_id, params.widget_id);
      await bus.emit('widget.updated', { account_id: query.account_id, at: now(), widget_id: params.widget_id, change: 'removed' });
      return { ok: true };
    },
    refresh: async ({ params, body }) => {
      const w = widget(params.widget_id, body.account_id);
      if (w.spec.kind !== 'display') throw new HttpError(404, 'not_found', 'only displays refresh');
      const hour = Date.now() - 3600_000;
      const recent = [...requested.values()].filter((r) => r.widget_id === w.spec.widget_id && r.reason === 'refresh' && r.at > hour);
      if (recent.length >= REFRESH_PER_HOUR) throw new HttpError(429, 'too_many_refreshes', 'this widget was refreshed too often this hour');
      return { job_id: await enqueueRun(w.spec, refreshKind(w.spec), 'refresh') };
    },
    addSource: async ({ params, body }) => {
      const w = widget(params.widget_id, body.account_id);
      if (!w.profile) throw new HttpError(400, 'no_profile', 'apps and folders have no sources');
      if (!w.profile.added_domains.includes(body.domain)) {
        if (w.profile.added_domains.length >= 20) throw new HttpError(400, 'too_many_sources', 'at most 20 added domains');
        w.profile.added_domains.push(body.domain);
      }
      await bus.emit('widget.updated', { account_id: body.account_id, at: now(), widget_id: params.widget_id, change: 'changed' });
      return shown(w);
    },
    putResult: async ({ params, body }) => {
      const w = widget(params.widget_id, body.account_id);
      checkResult(body, w.spec);
      if (w.result && w.result.run_id !== body.result.run_id) w.previous = w.result;
      w.result = body.result;
      delete w.quotes;
      w.state = body.result.blocked.length ? 'blocked' : 'normal';
      w.updated_at = now();
      traces.set(w.spec.widget_id, body.trace);
      await bus.emit('result.updated', { account_id: body.account_id, at: now(), widget_id: w.spec.widget_id, result_id: body.result.result_id, phase: body.phase });
      const flag = movementFlag(w.spec, body.result);
      if (flag) {
        await bus.emit('movement.flagged', { account_id: body.account_id, at: now(), widget_id: w.spec.widget_id, ...flag });
        // A move past the threshold starts a research run for this account's widgets that read sources on that market.
        for (const id of boards.get(body.account_id)!.widgets) {
          const r = widgets.get(id)!;
          if (r.spec.kind === 'display' && displayEntry(r.spec.type).research && r.spec.market_ids.includes(flag.market_id))
            await enqueueRun(r.spec, 'research', 'movement');
        }
      }
      return { result_id: body.result.result_id };
    },
    getTrace: ({ params, query }) => {
      widget(params.widget_id, query.account_id);
      return { steps: traces.get(params.widget_id) ?? [] };
    },
    putScreenshot: async ({ params, body }) => {
      widget(params.widget_id, body.account_id);
      const bytes = Buffer.from(body.png_base64, 'base64');
      if (!isPng(bytes)) throw new HttpError(400, 'not_png', 'a screenshot must be a PNG');
      const key = screenshotKey(params.widget_id, params.run_id, params.candidate_id);
      await objects.put(key, bytes, 'image/png');
      return { screenshot_key: key };
    },
    getScreenshot: async ({ params, query }) => {
      widget(params.widget_id, query.account_id);
      const key = screenshotKey(params.widget_id, params.run_id, params.candidate_id);
      const bytes = await objects.get(key);
      if (!bytes) throw new HttpError(404, 'not_found', 'no such screenshot');
      return { screenshot_key: key, content_type: 'image/png' as const, png_base64: bytes.toString('base64') };
    },
    getReceipt: ({ params, query }) => {
      for (const id of boards.get(query.account_id)?.widgets ?? []) {
        const w = widgets.get(id);
        const r = w?.result?.receipts.find((x) => x.id === params.receipt_id) ?? w?.previous?.receipts.find((x) => x.id === params.receipt_id);
        if (r) return r;
      }
      throw new HttpError(404, 'not_found', 'no such receipt on this board');
    },
  };

  /** Removing a folder puts its tiles back on the grid, below the rest. */
  function removeWidget(account_id: string, widget_id: string) {
    const b = boards.get(account_id)!;
    const w = widgets.get(widget_id);
    b.widgets = b.widgets.filter((id) => id !== widget_id);
    widgets.delete(widget_id);
    if (w?.spec.kind !== 'folder') return;
    const kids = b.widgets.map((id) => widgets.get(id)!).filter((c) => 'folder_id' in c.spec.place && c.spec.place.folder_id === widget_id);
    const places = packPlaces(kids.map((c) => (c.spec.kind === 'display' ? SIZE_CELLS[c.spec.size] : [1, 1])), nextRow(account_id));
    kids.forEach((c, i) => (c.spec = WidgetSpec.parse({ ...c.spec, place: places[i] })));
  }
}
