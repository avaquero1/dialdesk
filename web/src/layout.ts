/**
 * The grid, without the DOM: dense first-fit packing of an ordered list over 8 columns (4 on a phone), and the
 * conversion between that order and the places board stores. Displays are S 2×2, M 4×2, L 4×4, XL 8×4; apps and
 * folders 1×1. board stores desktop places ({col,row} on 8 columns); the order is the places sorted by row, then col.
 */
import type { Widget } from '@app/contracts';

export const DESKTOP_COLS = 8;
export const PHONE_COLS = 4;
const SIZE_CELLS = { S: [2, 2], M: [4, 2], L: [4, 4], XL: [8, 4] } as const;

export type Dims = readonly [number, number];
export interface Rect {
  c: number;
  r: number;
  w: number;
  h: number;
}

/** A tile's size in cells, capped at the column count (XL is 4 wide on a phone). */
export function dimsOf(spec: Widget['spec'], cols: number): Dims {
  if (spec.kind !== 'display') return [1, 1];
  const [w, h] = SIZE_CELLS[spec.size];
  return [Math.min(w, cols), h];
}

/** Dense first-fit: each tile takes the first free spot scanning rows top to bottom, columns left to right. */
export function pack(order: readonly string[], dims: (id: string) => Dims, cols: number): { rects: Map<string, Rect>; rows: number } {
  const occ: number[][] = [];
  const rects = new Map<string, Rect>();
  let rows = 0;
  const free = (c: number, r: number, w: number, h: number) => {
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (occ[y]?.[x]) return false;
    return true;
  };
  for (const id of order) {
    const [w, h] = dims(id);
    search: for (let r = 0; ; r++) {
      for (let c = 0; c + w <= cols; c++) {
        if (free(c, r, w, h)) {
          for (let y = r; y < r + h; y++) {
            occ[y] ??= [];
            for (let x = c; x < c + w; x++) occ[y]![x] = 1;
          }
          rects.set(id, { c, r, w, h });
          rows = Math.max(rows, r + h);
          break search;
        }
      }
    }
  }
  return { rects, rows };
}

const byPlace = (rects: Map<string, Rect>) => (a: string, b: string) => {
  const x = rects.get(a)!;
  const y = rects.get(b)!;
  return x.r - y.r || x.c - y.c;
};

/**
 * The order whose packing reads back as itself: sort the packed tiles by (row, col) and pack again, until it holds
 * (it settles in one or two rounds). Saving this order's places means a reload, which sorts places the same way,
 * rebuilds exactly the board the user left.
 */
export function canonical(order: readonly string[], dims: (id: string) => Dims, cols = DESKTOP_COLS): string[] {
  let cur = [...order];
  for (let i = 0; i < 6; i++) {
    const { rects } = pack(cur, dims, cols);
    const next = [...cur].sort(byPlace(rects));
    if (next.every((id, k) => id === cur[k])) return cur;
    cur = next;
  }
  return cur;
}

/** The desktop places to store for an order. */
export function placesFor(order: readonly string[], dims: (id: string) => Dims): { widget_id: string; place: { col: number; row: number } }[] {
  const { rects } = pack(order, dims, DESKTOP_COLS);
  return order.map((id) => {
    const r = rects.get(id)!;
    return { widget_id: id, place: { col: r.c, row: r.r } };
  });
}

/** The board's grid order and each folder's children, from the stored places. */
export function orderFromBoard(widgets: readonly Widget[]): { order: string[]; kids: Map<string, string[]> } {
  const grid: { id: string; col: number; row: number }[] = [];
  const inFolder = new Map<string, { id: string; index: number }[]>();
  for (const w of widgets) {
    const p = w.spec.place;
    if ('folder_id' in p) {
      const l = inFolder.get(p.folder_id) ?? [];
      l.push({ id: w.spec.widget_id, index: p.index });
      inFolder.set(p.folder_id, l);
    } else grid.push({ id: w.spec.widget_id, col: p.col, row: p.row });
  }
  grid.sort((a, b) => a.row - b.row || a.col - b.col);
  const kids = new Map<string, string[]>();
  for (const [f, l] of inFolder) kids.set(f, l.sort((a, b) => a.index - b.index).map((x) => x.id));
  return { order: grid.map((g) => g.id), kids };
}
