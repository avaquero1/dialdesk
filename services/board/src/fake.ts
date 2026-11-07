import {
  BOARD,
  QUEUES,
  WIDGET_CATALOG,
  WidgetSpec,
  displayEntry,
  newId,
  widgetRunJobId,
  type Board,
  type DefaultTile,
  type Proposal,
  type RunKind,
  type RunTraceStep,
  type Widget,
  type WidgetDraft,
  type WidgetProfile,
  type WidgetRunJob,
} from '@app/contracts';
import { HttpError, MemoryBus, now, type Bus, type Handlers } from '@app/service-kit';

export interface FakeDeps {
  bus?: Bus;
  /** Where enqueued runs go. Default: kept in memory (`fakeQueue`). */
  enqueue?: (queue: string, job: WidgetRunJob) => void | Promise<void>;
}
export async function fakeDepsFromEnv(): Promise<FakeDeps> {
  return {};
}

/** Runs the fake enqueued, for tests to read (the real board uses BullMQ on QUEUES.widgetRuns). */
export const fakeQueue: WidgetRunJob[] = [];

/** In-memory board: boards, widgets, proposals, results and traces. Validates every spec against the catalog. */
export function fake(deps: FakeDeps = {}): Handlers<typeof BOARD> {
  const bus = deps.bus ?? new MemoryBus();
  const enqueue = deps.enqueue ?? ((_q: string, j: WidgetRunJob) => void fakeQueue.push(j));
  const boards = new Map<string, { widgets: string[]; pending: string[] }>();
  const widgets = new Map<string, Widget>();
  const proposals = new Map<string, Proposal>();
  const traces = new Map<string, RunTraceStep[]>();

  const board = (account_id: string): Board => {
    const b = boards.get(account_id);
    if (!b) throw new HttpError(404, 'not_found', 'no board for this account');
    return {
      account_id,
      widgets: b.widgets.map((id) => widgets.get(id)!).filter(Boolean),
      pending: b.pending.map((id) => proposals.get(id)!).filter((p) => p.status === 'pending'),
    };
  };
  const widget = (widget_id: string, account_id: string): Widget => {
    const w = widgets.get(widget_id);
    if (!w || w.spec.account_id !== account_id) throw new HttpError(404, 'not_found', 'no such widget');
    return w;
  };
  const defaultProfile = (widget_id: string, type: Parameters<typeof displayEntry>[0], brief = ''): WidgetProfile => {
    const e = displayEntry(type);
    return { widget_id, brief, source_ids: [...e.default_sources], added_domains: [], cadence: { ...e.default_cadence }, feedback: [], last_math_plan: null };
  };
  const nextRow = (account_id: string) => {
    const b = boards.get(account_id)!;
    return b.widgets.length;
  };
  async function enqueueRun(w: Widget, kind: RunKind, reason: WidgetRunJob['reason']) {
    const window_start = Math.floor(Date.now() / 1000 / 60) * 60;
    const job: WidgetRunJob = {
      job_id: widgetRunJobId(w.spec.widget_id, kind, window_start),
      widget_id: w.spec.widget_id,
      account_id: w.spec.account_id,
      kind,
      window_start,
      reason,
    };
    await enqueue(QUEUES.widgetRuns, job);
    return job.job_id;
  }
  async function addDisplay(account_id: string, d: WidgetDraft | Extract<DefaultTile, { kind: 'display' }>, place: Widget['spec']['place']) {
    const entry = displayEntry(d.type);
    const size = d.size ?? entry.default_size;
    if (!entry.sizes.includes(size)) throw new HttpError(400, 'bad_size', `${d.type} has no size ${size}`);
    const widget_id = newId('wid');
    const spec = WidgetSpec.parse({ widget_id, account_id, kind: 'display', type: d.type, size, title: d.title, market_ids: d.market_ids, params: d.params, place });
    const w: Widget = {
      spec,
      profile: defaultProfile(widget_id, d.type, 'brief' in d ? (d.brief ?? '') : ''),
      state: 'new',
      result: null,
      previous: null,
      updated_at: now(),
    };
    widgets.set(widget_id, w);
    boards.get(account_id)!.widgets.push(widget_id);
    await bus.emit('widget.updated', { account_id, at: now(), widget_id, change: 'added' });
    return w;
  }

  return {
    getBoard: ({ params }) => board(params.account_id),
    createDefaults: async ({ params }) => {
      const account_id = params.account_id;
      if (boards.has(account_id)) throw new HttpError(409, 'exists', 'board already exists');
      boards.set(account_id, { widgets: [], pending: [] });
      let col = 0;
      for (const tile of WIDGET_CATALOG.default_board.tiles) {
        const place = { col: col++ % 8, row: Math.floor(col / 8) };
        if (tile.kind === 'display') {
          const w = await addDisplay(account_id, tile, place);
          w.state = 'normal';
          await enqueueRun(w, 'numbers', 'accept');
        } else if (tile.kind === 'app') {
          const widget_id = newId('wid');
          widgets.set(widget_id, {
            spec: { widget_id, account_id, kind: 'app', app: tile.app, title: tile.title, place },
            profile: null, state: 'normal', result: null, previous: null, updated_at: now(),
          });
          boards.get(account_id)!.widgets.push(widget_id);
        } else {
          const folder_id = newId('wid');
          const children: string[] = [];
          widgets.set(folder_id, {
            spec: { widget_id: folder_id, account_id, kind: 'folder', title: tile.title, children, place },
            profile: null, state: 'normal', result: null, previous: null, updated_at: now(),
          });
          boards.get(account_id)!.widgets.push(folder_id);
          for (const [index, child] of tile.children.entries()) {
            const w = await addDisplay(account_id, child, { folder_id, index });
            w.state = 'normal';
            children.push(w.spec.widget_id);
          }
        }
      }
      return board(account_id);
    },
    setLayout: ({ params, body }) => {
      const b = board(params.account_id);
      for (const { widget_id, place } of body.places) {
        const w = widget(widget_id, b.account_id);
        w.spec = WidgetSpec.parse({ ...w.spec, place });
      }
      return board(params.account_id);
    },
    propose: ({ params, body }) => {
      const b = boards.get(params.account_id);
      if (!b) throw new HttpError(404, 'not_found', 'no board for this account');
      for (const c of body.changes) {
        if (c.op === 'add' && c.widget.size && !displayEntry(c.widget.type).sizes.includes(c.widget.size))
          throw new HttpError(400, 'bad_size', `${c.widget.type} has no size ${c.widget.size}`);
        if (c.op !== 'add') widget(c.widget_id, params.account_id);
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
      const out: Widget[] = [];
      for (const c of p.changes) {
        if (c.op === 'add') {
          const w = await addDisplay(p.account_id, c.widget, { col: 0, row: 8 + nextRow(p.account_id) });
          await enqueueRun(w, 'numbers', 'accept');
          if (displayEntry(c.widget.type).research) await enqueueRun(w, 'research', 'accept');
          out.push(w);
        } else if (c.op === 'tune') {
          const w = widget(c.widget_id, p.account_id);
          if (w.spec.kind === 'display') {
            w.spec = WidgetSpec.parse({
              ...w.spec,
              size: c.size ?? w.spec.size,
              params: { ...w.spec.params, ...(c.user_probability !== undefined && { user_probability: c.user_probability }), ...(c.threshold_pts !== undefined && { threshold_pts: c.threshold_pts }) },
            });
          }
          if (w.profile && c.brief !== undefined) w.profile.brief = c.brief;
          out.push(w);
        } else {
          const b = boards.get(p.account_id)!;
          b.widgets = b.widgets.filter((id) => id !== c.widget_id);
          widgets.delete(c.widget_id);
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
    getWidget: ({ params, query }) => widget(params.widget_id, query.account_id),
    resize: ({ params, body }) => {
      const w = widget(params.widget_id, body.account_id);
      if (w.spec.kind !== 'display' || !displayEntry(w.spec.type).sizes.includes(body.size))
        throw new HttpError(400, 'bad_size', 'that size is not in the catalog for this widget');
      w.spec = { ...w.spec, size: body.size };
      return w;
    },
    clear: async ({ params, body }) => {
      const w = widget(params.widget_id, body.account_id);
      if (w.spec.kind === 'display') w.profile = defaultProfile(w.spec.widget_id, w.spec.type);
      await bus.emit('widget.updated', { account_id: body.account_id, at: now(), widget_id: params.widget_id, change: 'cleared' });
      return w;
    },
    remove: ({ params, query }) => {
      widget(params.widget_id, query.account_id);
      const b = boards.get(query.account_id)!;
      b.widgets = b.widgets.filter((id) => id !== params.widget_id);
      widgets.delete(params.widget_id);
      return { ok: true };
    },
    refresh: async ({ params, body }) => {
      const w = widget(params.widget_id, body.account_id);
      if (w.spec.kind !== 'display') throw new HttpError(404, 'not_found', 'only displays refresh');
      const kind = displayEntry(w.spec.type).research ? 'research' : 'numbers';
      return { job_id: await enqueueRun(w, kind, 'refresh') };
    },
    addSource: ({ params, body }) => {
      const w = widget(params.widget_id, body.account_id);
      if (!w.profile) throw new HttpError(400, 'no_profile', 'apps and folders have no sources');
      if (!w.profile.added_domains.includes(body.domain)) w.profile.added_domains.push(body.domain);
      return w;
    },
    putResult: async ({ params, body }) => {
      const w = widget(params.widget_id, body.account_id);
      const v = body.verdict;
      if (v.stage !== 'publish' || v.outcome !== 'pass' || v.verdict_id !== body.result.verdict_id)
        throw new HttpError(422, 'no_passing_verdict', 'a result needs its passing publish verdict');
      if (body.result.widget_id !== w.spec.widget_id) throw new HttpError(400, 'wrong_widget', 'result is for another widget');
      if (w.result && w.result.run_id !== body.result.run_id) w.previous = w.result;
      w.result = body.result;
      w.state = body.result.blocked.length ? 'blocked' : 'normal';
      w.updated_at = now();
      traces.set(w.spec.widget_id, body.trace);
      await bus.emit('result.updated', { account_id: body.account_id, at: now(), widget_id: w.spec.widget_id, result_id: body.result.result_id, phase: body.phase });
      return { result_id: body.result.result_id };
    },
    getTrace: ({ params, query }) => {
      widget(params.widget_id, query.account_id);
      return { steps: traces.get(params.widget_id) ?? [] };
    },
    getReceipt: ({ params, query }) => {
      const b = boards.get(query.account_id);
      for (const id of b?.widgets ?? []) {
        const w = widgets.get(id);
        const r = w?.result?.receipts.find((x) => x.id === params.receipt_id) ?? w?.previous?.receipts.find((x) => x.id === params.receipt_id);
        if (r) return r;
      }
      for (const w of widgets.values()) {
        if (w.spec.account_id !== query.account_id) continue;
        const r = w.result?.receipts.find((x) => x.id === params.receipt_id);
        if (r) return r;
      }
      throw new HttpError(404, 'not_found', 'no such receipt on this board');
    },
  };
}
