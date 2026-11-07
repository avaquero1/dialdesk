/**
 * board's behaviors, run against the fake (fake.test.ts) and against Postgres (real.test.ts): first paint, folders,
 * the result check, "since you last looked", movement flags, refresh limits, screenshots and account isolation.
 */
import { BOARD, MARKETS, WIDGET_CATALOG, newId, type Board, type Widget, type WidgetRunJob } from '@app/contracts';
import { createClient, type Call, type MemoryBus } from '@app/service-kit';
import { sampleResult, TEST_TOKENS } from '@app/testkit';
import type { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { REFRESH_PER_HOUR } from '../src/logic.ts';
import { TINY_PNG, marketsForBoard } from './cases.ts';

export interface Rig {
  app: Hono;
  bus: MemoryBus;
  jobs: WidgetRunJob[];
}

const as = (app: Hono, caller: keyof typeof TEST_TOKENS): Call =>
  createClient({ baseUrl: 'http://board.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });
const acc = () => newId('acc');
const displays = (b: Board) => b.widgets.filter((w) => w.spec.kind === 'display') as (Widget & { spec: { kind: 'display' } })[];
const status = async (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 0);

function movementResult(widget_id: string, account_id: string, move: number) {
  const body: Omit<ReturnType<typeof sampleResult>, 'phase'> & { phase: 'numbers' | 'summary' } = sampleResult(widget_id, account_id, 'pass');
  body.result.kind = 'numbers';
  body.result.summary = null;
  body.result.facts = [];
  body.result.sources = [];
  body.result.numbers = [{ id: 'n1', op: 'movement', value: move, unit: 'points', receipt_id: 'r-0a1b2c3d' }];
  body.result.receipts = [{ ...body.result.receipts[0]!, op: 'movement', op_id: 'n1', value: move, unit: 'points', formula: 'move = now_cents - then_cents' }];
  body.phase = 'numbers';
  body.trace = body.trace.map((s) => ({ ...s, run_id: body.result.run_id }));
  return body;
}

export function boardBehaviors(name: string, rig: () => Promise<Rig>) {
  describe(`board behaviors: ${name}`, () => {
    let r: Rig;
    let edge: Call, agent: Call, runner: Call;
    const markets = marketsForBoard();
    beforeAll(async () => {
      r = await rig();
      edge = as(r.app, 'edge');
      agent = as(r.app, 'agent');
      runner = as(r.app, 'runner');
    });
    let shift = 0;
    afterEach(() => {
      vi.useRealTimers();
      shift = 0;
    });
    /** Moves only Date (not timers, which the Postgres client needs) one more minute ahead: the next run window. */
    const nextMinute = () => {
      shift += 60_000;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(vi.getRealSystemTime() + shift);
    };

    it('first paint: a new board is the prescribed default board, with cached prices before any run', async () => {
      const a = acc();
      const before = r.jobs.length;
      const b = await edge(BOARD.createDefaults, { params: { account_id: a }, body: { category: 'sports' } });
      const tiles = WIDGET_CATALOG.default_board.tiles;
      const grid = b.widgets.filter((w) => 'col' in w.spec.place);
      expect(grid.map((w) => w.spec.title)).toEqual(tiles.map((t) => t.title));
      const ds = displays(b);
      expect(ds).toHaveLength(6 + 4 + 3);
      for (const w of ds) {
        expect(w.result).toBeNull();
        if (w.spec.market_ids.length === 0) {
          expect(w.quotes).toBeUndefined();
          continue;
        }
        expect(w.quotes?.map((q) => q.market_id)).toEqual(w.spec.market_ids);
        const m = await markets(MARKETS.get, { params: { market_id: w.spec.market_ids[0]! } });
        expect(w.quotes![0]!.yes_price_cents).toBe(m.yes_price_cents);
      }
      // Every display gets a numbers run at once.
      const jobs = r.jobs.slice(before);
      expect(jobs.map((j) => j.kind)).toEqual(ds.map(() => 'numbers'));
      expect(new Set(jobs.map((j) => j.widget_id))).toEqual(new Set(ds.map((w) => w.spec.widget_id)));
      // The same board comes back on the next read.
      const again = await edge(BOARD.getBoard, { params: { account_id: a } });
      expect(again.widgets.map((w) => w.spec.widget_id)).toEqual(b.widgets.map((w) => w.spec.widget_id));
      expect(r.bus.events.filter((e) => e.event === 'widget.updated' && (e.payload as { account_id: string }).account_id === a)).toHaveLength(ds.length);
    });

    it('folders: children follow the layout; folders do not nest; removing a folder puts its tiles back on the grid', async () => {
      const a = acc();
      const b = await edge(BOARD.createDefaults, { params: { account_id: a }, body: { category: 'sports' } });
      const [nfl, nba] = b.widgets.filter((w) => w.spec.kind === 'folder');
      if (nfl?.spec.kind !== 'folder' || nba?.spec.kind !== 'folder') throw new Error('no folders');
      expect(nfl.spec.children).toHaveLength(4);
      const card = nfl.spec.children[0]!;
      const moved = await edge(BOARD.setLayout, { params: { account_id: a }, body: { places: [{ widget_id: card, place: { folder_id: nba.spec.widget_id, index: 3 } }] } });
      const f = (id: string) => moved.widgets.find((w) => w.spec.widget_id === id)!.spec as { children: string[] };
      expect(f(nfl.spec.widget_id).children).toHaveLength(3);
      expect(f(nba.spec.widget_id).children.at(-1)).toBe(card);
      expect(await status(edge(BOARD.setLayout, { params: { account_id: a }, body: { places: [{ widget_id: nfl.spec.widget_id, place: { folder_id: nba.spec.widget_id, index: 0 } }] } }))).toBe(400);
      await edge(BOARD.remove, { params: { widget_id: nba.spec.widget_id }, query: { account_id: a } });
      const after = await edge(BOARD.getBoard, { params: { account_id: a } });
      const back = after.widgets.find((w) => w.spec.widget_id === card)!;
      expect('col' in back.spec.place).toBe(true);
      expect(after.widgets.filter((w) => w.spec.kind === 'folder')).toHaveLength(1);
    });

    it('proposals stay pending until the click; accept validates, saves and enqueues numbers then research', async () => {
      const a = acc();
      await edge(BOARD.createDefaults, { params: { account_id: a }, body: { category: 'sports' } });
      const news = { kind: 'display' as const, type: 'news' as const, title: 'Lakers news', market_ids: ['kalshi:KXNBAGAME-26NOV07LALBOS-LAL'], params: { team: 'Lakers' } };
      const p = await agent(BOARD.propose, { params: { account_id: a }, body: { changes: [{ op: 'add', widget: news }] } });
      const b = await agent(BOARD.getBoard, { params: { account_id: a } });
      expect(b.pending.map((x) => x.proposal_id)).toEqual([p.proposal_id]);
      expect(b.widgets.some((w) => w.spec.title === 'Lakers news')).toBe(false);
      const before = r.jobs.length;
      const out = await edge(BOARD.accept, { params: { proposal_id: p.proposal_id }, body: { account_id: a } });
      expect(out.widgets[0]!.state).toBe('new');
      expect(out.widgets[0]!.quotes?.[0]?.market_id).toBe('kalshi:KXNBAGAME-26NOV07LALBOS-LAL');
      expect(r.jobs.slice(before).map((j) => j.kind)).toEqual(['numbers', 'research']);
      expect((await agent(BOARD.getBoard, { params: { account_id: a } })).pending).toEqual([]);
      // A tune that breaks the catalog is refused at propose.
      expect(await status(agent(BOARD.propose, { params: { account_id: a }, body: { changes: [{ op: 'tune', widget_id: out.widgets[0]!.spec.widget_id, threshold_pts: 5 }] } }))).toBe(400);
    });

    it('results: refused without a passing verdict or when board\'s own guard check fails; previous kept for "since you last looked"', async () => {
      const a = acc();
      const b = await edge(BOARD.createDefaults, { params: { account_id: a }, body: { category: 'sports' } });
      const w = displays(b).find((x) => x.spec.type === 'news')!;
      const wid = w.spec.widget_id;
      expect(await status(runner(BOARD.putResult, { params: { widget_id: wid }, body: sampleResult(wid, a, 'block') }))).toBe(422);
      const advice = sampleResult(wid, a, 'pass');
      advice.result.summary!.template = 'You should buy {n1}.';
      expect(await status(runner(BOARD.putResult, { params: { widget_id: wid }, body: advice }))).toBe(422);
      const other = sampleResult(wid, a, 'pass');
      other.result.widget_id = displays(b)[0]!.spec.widget_id;
      expect(await status(runner(BOARD.putResult, { params: { widget_id: wid }, body: other }))).toBe(400);
      expect((await edge(BOARD.getWidget, { params: { widget_id: wid }, query: { account_id: a } })).result).toBeNull();

      const first = sampleResult(wid, a, 'pass');
      await runner(BOARD.putResult, { params: { widget_id: wid }, body: first });
      let got = await edge(BOARD.getWidget, { params: { widget_id: wid }, query: { account_id: a } });
      expect(got.result?.result_id).toBe(first.result.result_id);
      expect(got.previous).toBeNull();
      expect(got.quotes).toBeUndefined();
      const second = sampleResult(wid, a, 'pass');
      await runner(BOARD.putResult, { params: { widget_id: wid }, body: second });
      // The summary phase of the same run replaces "current" and leaves "previous" alone.
      const summary = { ...second, result: { ...second.result, result_id: newId('res') } };
      await runner(BOARD.putResult, { params: { widget_id: wid }, body: summary });
      got = await edge(BOARD.getWidget, { params: { widget_id: wid }, query: { account_id: a } });
      expect(got.result?.result_id).toBe(summary.result.result_id);
      expect(got.previous?.result_id).toBe(first.result.result_id);
      expect((await edge(BOARD.getTrace, { params: { widget_id: wid }, query: { account_id: a } })).steps).toEqual(second.trace);
      expect((await agent(BOARD.getReceipt, { params: { receipt_id: 'r-1b2c3d4e' }, query: { account_id: a } })).formula).toBe('gap = b_cents - a_cents');
      const updates = r.bus.events.filter((e) => e.event === 'result.updated' && (e.payload as { widget_id: string }).widget_id === wid);
      expect(updates).toHaveLength(3);
    });

    it('movement past the threshold raises movement.flagged and starts research on that market', async () => {
      const a = acc();
      const b = await edge(BOARD.createDefaults, { params: { account_id: a }, body: { category: 'sports' } });
      const mv = displays(b).find((x) => x.spec.type === 'movement')!;
      const market = mv.spec.market_ids[0]!;
      const p = await agent(BOARD.propose, {
        params: { account_id: a },
        body: { changes: [{ op: 'add', widget: { kind: 'display', type: 'news', title: 'Lakers news', market_ids: [market], params: { team: 'Lakers' } } }] },
      });
      const news = (await edge(BOARD.accept, { params: { proposal_id: p.proposal_id }, body: { account_id: a } })).widgets[0]!;
      const flagged = () => r.bus.events.filter((e) => e.event === 'movement.flagged' && (e.payload as { account_id: string }).account_id === a);
      await runner(BOARD.putResult, { params: { widget_id: mv.spec.widget_id }, body: movementResult(mv.spec.widget_id, a, 2) });
      expect(flagged()).toHaveLength(0);
      nextMinute(); // the research run from the accept had this minute's job id
      const before = r.jobs.length;
      await runner(BOARD.putResult, { params: { widget_id: mv.spec.widget_id }, body: movementResult(mv.spec.widget_id, a, -7) });
      expect(flagged().map((e) => e.payload)).toMatchObject([{ widget_id: mv.spec.widget_id, market_id: market, move_pts: -7, threshold_pts: 5 }]);
      const research = r.jobs.slice(before).filter((j) => j.reason === 'movement');
      expect(research.map((j) => [j.widget_id, j.kind])).toEqual([[news.spec.widget_id, 'research']]);
    });

    it('refresh: one job per minute window, and too many runs in an hour answer 429', async () => {
      const a = acc();
      const b = await edge(BOARD.createDefaults, { params: { account_id: a }, body: { category: 'sports' } });
      const wid = displays(b).find((x) => x.spec.type === 'gap')!.spec.widget_id;
      nextMinute(); // this minute's numbers job is the one board made with the board
      const j1 = await edge(BOARD.refresh, { params: { widget_id: wid }, body: { account_id: a } });
      const j2 = await edge(BOARD.refresh, { params: { widget_id: wid }, body: { account_id: a } });
      expect(j2.job_id).toBe(j1.job_id);
      expect(j1.job_id).toMatch(new RegExp(`^${wid}:numbers:[0-9]+$`));
      for (let i = 1; i < REFRESH_PER_HOUR; i++) {
        nextMinute();
        await edge(BOARD.refresh, { params: { widget_id: wid }, body: { account_id: a } });
      }
      nextMinute();
      expect(await status(edge(BOARD.refresh, { params: { widget_id: wid }, body: { account_id: a } }))).toBe(429);
    });

    it("screenshots round-trip through the object store, and one account can't read another's board", async () => {
      const a = acc();
      const intruder = acc();
      const b = await edge(BOARD.createDefaults, { params: { account_id: a }, body: { category: 'sports' } });
      await edge(BOARD.createDefaults, { params: { account_id: intruder }, body: { category: 'sports' } });
      const wid = displays(b).find((x) => x.spec.type === 'news')!.spec.widget_id;
      const ids = { widget_id: wid, run_id: newId('run'), candidate_id: newId('cnd') };
      const { screenshot_key } = await runner(BOARD.putScreenshot, { params: ids, body: { account_id: a, png_base64: TINY_PNG } });
      expect(screenshot_key).toBe(`screenshots/${wid}/${ids.run_id}/${ids.candidate_id}.png`);
      const got = await edge(BOARD.getScreenshot, { params: ids, query: { account_id: a } });
      expect(got.png_base64).toBe(TINY_PNG);
      expect(await status(edge(BOARD.getScreenshot, { params: ids, query: { account_id: intruder } }))).toBe(404);
      expect(await status(runner(BOARD.putScreenshot, { params: ids, body: { account_id: intruder, png_base64: TINY_PNG } }))).toBe(404);
      expect(await status(edge(BOARD.getWidget, { params: { widget_id: wid }, query: { account_id: intruder } }))).toBe(404);
      expect(await status(edge(BOARD.remove, { params: { widget_id: wid }, query: { account_id: intruder } }))).toBe(404);
      await runner(BOARD.putResult, { params: { widget_id: wid }, body: sampleResult(wid, a, 'pass') });
      expect(await status(agent(BOARD.getReceipt, { params: { receipt_id: 'r-0a1b2c3d' }, query: { account_id: intruder } }))).toBe(404);
    });
  });
}
