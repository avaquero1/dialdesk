/** A folder change shown before the server has it: the overlay, and a temporary id replaced everywhere it was used. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Widget } from '@app/contracts';

vi.stubGlobal('document', { documentElement: { dataset: {} } });
const { S, adoptFolder, withLocal } = await import('../../src/board.ts');
type Change = import('../../src/board.ts').LocalChange;

const widget = (widget_id: string, place: Widget['spec']['place'], kind: 'display' | 'folder' = 'display'): Widget =>
  ({ spec: { widget_id, account_id: 'acc', kind, title: widget_id, ...(kind === 'folder' ? { children: [] } : {}), place }, profile: null, state: 'normal', result: null, previous: null, updated_at: 't' }) as unknown as Widget;
const at = (col: number, row = 0) => ({ col, row });
const placeOf = (ws: readonly Widget[], id: string) => ws.find((w) => w.spec.widget_id === id)?.spec.place;

beforeEach(() => {
  S.local = [];
  S.order = [];
});

describe('withLocal', () => {
  const board = [widget('a', at(0)), widget('b', at(2)), widget('f', at(4), 'folder')];

  it('adds a made folder and puts its cards in it, leaving the server board as it was', () => {
    const c: Change = { folder: widget('tmp_1', at(2), 'folder'), places: new Map([['b', { folder_id: 'tmp_1', index: 0 }], ['a', { folder_id: 'tmp_1', index: 1 }]]) };
    const view = withLocal(board, [c]);
    expect(view.map((w) => w.spec.widget_id)).toContain('tmp_1');
    expect(placeOf(view, 'a')).toEqual({ folder_id: 'tmp_1', index: 1 });
    expect(placeOf(board, 'a')).toEqual(at(0));
  });

  it('takes a folder off when its last card leaves, and renames', () => {
    const view = withLocal(board, [{ places: new Map(), gone: 'f' }, { places: new Map(), title: { id: 'a', title: 'Mine' } }]);
    expect(view.some((w) => w.spec.widget_id === 'f')).toBe(false);
    expect(view.find((w) => w.spec.widget_id === 'a')?.spec.title).toBe('Mine');
  });

  it('applies changes in order: a later change sees the earlier ones', () => {
    const made: Change = { folder: widget('tmp_1', at(2), 'folder'), places: new Map([['b', { folder_id: 'tmp_1', index: 0 }]]) };
    const added: Change = { places: new Map([['a', { folder_id: 'tmp_1', index: 1 }]]) };
    expect(placeOf(withLocal(board, [made, added]), 'a')).toEqual({ folder_id: 'tmp_1', index: 1 });
  });
});

describe('adoptFolder', () => {
  it('moves the waiting changes from the temporary id to the real one', () => {
    S.local = [
      { places: new Map<string, Widget['spec']['place']>([['tmp_1', at(0)], ['c', { folder_id: 'tmp_1', index: 2 }]]) },
      { places: new Map(), gone: 'tmp_1' },
      { places: new Map(), title: { id: 'tmp_1', title: 'Mine' } },
    ];
    S.order = ['tmp_1', 'x'];
    adoptFolder('tmp_1', 'wid_real');
    expect([...S.local[0]!.places.keys()]).toEqual(['wid_real', 'c']);
    expect(S.local[0]!.places.get('c')).toEqual({ folder_id: 'wid_real', index: 2 });
    expect(S.local[1]!.gone).toBe('wid_real');
    expect(S.local[2]!.title?.id).toBe('wid_real');
    expect(S.order).toEqual(['wid_real', 'x']);
  });
});
