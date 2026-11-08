import { describe, expect, it, vi } from 'vitest';
import { WIDGET_CATALOG, displayEntry, newId, type Widget } from '@app/contracts';
import { LABELS, NOT_YET, foldersFor, menuRows, sizesFor } from '../../src/menu.ts';
import { Undo, type Change } from '../../src/undo.ts';

/** The prescribed default board's grid tiles as widgets. */
function defaultBoard(): Widget[] {
  const acc = newId('acc');
  return WIDGET_CATALOG.default_board.tiles.map((t) => {
    const base = { widget_id: newId('wid'), account_id: acc, title: t.title, place: { col: 0, row: 0 } };
    const spec: Widget['spec'] =
      t.kind === 'display'
        ? { ...base, kind: 'display', type: t.type, size: t.size, market_ids: t.market_ids, params: t.params }
        : t.kind === 'app'
          ? { ...base, kind: 'app', app: t.app }
          : { ...base, kind: 'folder', children: [] };
    return { spec, profile: null, state: 'normal', result: null, previous: null, updated_at: new Date().toISOString() };
  });
}
const board = defaultBoard();
const byKind = (k: Widget['spec']['kind']) => board.find((w) => w.spec.kind === k)!;

describe('the ⋯ menu rows', () => {
  it('has the same seven rows in the same order on every tile, whatever applies', () => {
    const labels = board.map((w) => menuRows(w, board).map((r) => r.label));
    for (const l of labels) expect(l).toEqual(Object.values(LABELS));
  });

  it('has no row left greyed for a later step', () => {
    expect(NOT_YET.size).toBe(0);
  });

  it('a display: every row is on (change it with the agent, refresh, size, how we got this, move, clear, remove)', () => {
    const on = menuRows(byKind('display'), board).filter((r) => r.on).map((r) => r.action);
    expect(on).toEqual(['agent', 'refresh', 'size', 'how', 'move', 'clear', 'remove']);
  });

  it('an app: only move and remove; a folder: only remove (folders don\'t nest)', () => {
    expect(menuRows(byKind('app'), board).filter((r) => r.on).map((r) => r.action)).toEqual(['move', 'remove']);
    expect(menuRows(byKind('folder'), board).filter((r) => r.on).map((r) => r.action)).toEqual(['remove']);
    expect(foldersFor(byKind('folder'), board)).toEqual([]);
  });

  it('move is greyed when the board has no folder', () => {
    const noFolders = board.filter((w) => w.spec.kind !== 'folder');
    expect(menuRows(byKind('display'), noFolders).find((r) => r.action === 'move')!.on).toBe(false);
  });

  it('a display that is refreshing has Refresh greyed', () => {
    const w = { ...byKind('display'), state: 'refreshing' as const };
    expect(menuRows(w, board).find((r) => r.action === 'refresh')!.on).toBe(false);
  });

  it('sizes: always S M L XL; only the catalog\'s sizes for the type are on, the current one is marked, not on', () => {
    for (const w of board) {
      const z = sizesFor(w);
      expect(z.map((s) => s.size)).toEqual(['S', 'M', 'L', 'XL']);
      if (w.spec.kind !== 'display') {
        expect(z.every((s) => !s.on && !s.cur)).toBe(true);
        continue;
      }
      const allowed = displayEntry(w.spec.type).sizes as readonly string[];
      const cur = w.spec.size;
      for (const s of z) {
        expect(s.cur).toBe(s.size === cur);
        expect(s.on).toBe(allowed.includes(s.size) && s.size !== cur);
      }
    }
  });
});

describe('Undo', () => {
  function setup(ms = 5000) {
    vi.useFakeTimers();
    const view = { show: vi.fn(), hide: vi.fn() };
    const errors: unknown[] = [];
    const u = new Undo(view, ms, { set: (fn, t) => setTimeout(fn, t) as unknown as number, clear: (t) => clearTimeout(t) }, (_c, e) => errors.push(e));
    const log: string[] = [];
    const change = (name: string, fail = false): Change => ({
      text: name,
      apply: () => log.push(`apply ${name}`),
      revert: () => log.push(`revert ${name}`),
      commit: ({ keepalive }) => {
        log.push(`commit ${name}${keepalive ? ' keepalive' : ''}`);
        return fail ? Promise.reject(new Error('500')) : Promise.resolve();
      },
    });
    return { u, view, log, change, errors };
  }

  it('applies at once, sends only when the offer ends', async () => {
    const { u, view, log, change } = setup();
    u.offer(change('remove A'));
    expect(log).toEqual(['apply remove A']);
    expect(view.show).toHaveBeenCalledWith('remove A', 5000);
    expect(u.waiting).toBe(true);
    await vi.advanceTimersByTimeAsync(4999);
    expect(log).toEqual(['apply remove A']);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(['apply remove A', 'commit remove A']);
    expect(view.hide).toHaveBeenCalled();
    expect(u.waiting).toBe(false);
    vi.useRealTimers();
  });

  it('Undo in time reverts and sends nothing, ever', async () => {
    const { u, log, change } = setup();
    u.offer(change('clear B'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(u.undo()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(['apply clear B', 'revert clear B']);
    expect(u.undo()).toBe(false);
    vi.useRealTimers();
  });

  it('Undo after the offer ended does nothing', async () => {
    const { u, log, change } = setup();
    u.offer(change('remove C'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(u.undo()).toBe(false);
    expect(log).toEqual(['apply remove C', 'commit remove C']);
    vi.useRealTimers();
  });

  it('a second offer sends the first one now; Undo then takes back only the second', async () => {
    const { u, log, change } = setup();
    u.offer(change('remove A'));
    u.offer(change('remove B'));
    expect(log).toEqual(['apply remove A', 'commit remove A', 'apply remove B']);
    u.undo();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(['apply remove A', 'commit remove A', 'apply remove B', 'revert remove B']);
    vi.useRealTimers();
  });

  it('leaving the page sends what waits, with keepalive', async () => {
    const { u, log, change } = setup();
    u.offer(change('remove A'));
    await u.send(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(['apply remove A', 'commit remove A keepalive']);
    vi.useRealTimers();
  });

  it('a failed send puts the tile back and reports the error', async () => {
    const { u, log, change, errors } = setup();
    u.offer(change('remove A', true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toEqual(['apply remove A', 'commit remove A', 'revert remove A']);
    expect(errors).toHaveLength(1);
    vi.useRealTimers();
  });
});
