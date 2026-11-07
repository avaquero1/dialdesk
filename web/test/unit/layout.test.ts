import { describe, expect, it } from 'vitest';
import { WIDGET_CATALOG, newId, type Widget } from '@app/contracts';
import { ApiError, noticeFor } from '../../src/api.ts';
import { DESKTOP_COLS, PHONE_COLS, canonical, dimsOf, orderFromBoard, pack, placesFor } from '../../src/layout.ts';
import { checkHtml } from '../../build.ts';

/** The prescribed default board's grid tiles as widget specs (no folder children). */
function defaultSpecs(): Widget['spec'][] {
  const acc = newId('acc');
  return WIDGET_CATALOG.default_board.tiles.map((t) => {
    const base = { widget_id: newId('wid'), account_id: acc, title: t.title, place: { col: 0, row: 0 } };
    if (t.kind === 'display') return { ...base, kind: 'display', type: t.type, size: t.size, market_ids: t.market_ids, params: t.params };
    if (t.kind === 'app') return { ...base, kind: 'app', app: t.app };
    return { ...base, kind: 'folder', children: [] };
  });
}
const asWidgets = (specs: Widget['spec'][]): Widget[] =>
  specs.map((spec) => ({ spec, profile: null, state: 'normal', result: null, previous: null, updated_at: new Date().toISOString() }));

function shuffle<T>(a: T[], seed: number): T[] {
  const out = [...a];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('the grid', () => {
  const specs = defaultSpecs();
  const byId = new Map(specs.map((s) => [s.widget_id, s]));
  const dims8 = (id: string) => dimsOf(byId.get(id)!, DESKTOP_COLS);

  it('packs the default board into 7 rows on 8 columns, with no overlap', () => {
    const order = specs.map((s) => s.widget_id);
    const { rects, rows } = pack(order, dims8, DESKTOP_COLS);
    expect(rows).toBe(7);
    const cells = new Set<string>();
    for (const r of rects.values())
      for (let y = r.r; y < r.r + r.h; y++)
        for (let x = r.c; x < r.c + r.w; x++) {
          expect(x).toBeLessThan(DESKTOP_COLS);
          expect(cells.has(`${x},${y}`)).toBe(false);
          cells.add(`${x},${y}`);
        }
  });

  it('caps an XL display at 4 columns on a phone', () => {
    const xl = { ...specs[0]!, kind: 'display', size: 'XL' } as Widget['spec'];
    expect(dimsOf(xl, PHONE_COLS)).toEqual([4, 4]);
    expect(dimsOf(xl, DESKTOP_COLS)).toEqual([8, 4]);
  });

  it('stores an order that reads back as itself after a reload, for any drag result', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const order = canonical(shuffle(specs.map((s) => s.widget_id), seed), dims8);
      // Store the places, then read them back the way a reload does.
      const places = new Map(placesFor(order, dims8).map((p) => [p.widget_id, p.place]));
      const stored = asWidgets(specs.map((s) => ({ ...s, place: places.get(s.widget_id)! })));
      const back = orderFromBoard(stored).order;
      expect(back).toEqual(order);
      expect(pack(back, dims8, DESKTOP_COLS).rects).toEqual(pack(order, dims8, DESKTOP_COLS).rects);
    }
  });

  it('keeps folder children out of the grid, in their index order', () => {
    const folder = specs.find((s) => s.kind === 'folder')!;
    const kids = [2, 0, 1].map((index) => ({ ...specs[0]!, widget_id: newId('wid'), place: { folder_id: folder.widget_id, index } })) as Widget['spec'][];
    const { order, kids: k } = orderFromBoard(asWidgets([...specs, ...kids]));
    expect(order).toHaveLength(specs.length);
    expect(k.get(folder.widget_id)).toEqual([kids[1]!.widget_id, kids[2]!.widget_id, kids[0]!.widget_id]);
  });
});

describe('edge answers on any route', () => {
  it('turns 429, 413 and offline into words', () => {
    expect(noticeFor(new ApiError(429, 'rate_limited', 'x'))).toMatch(/Too many requests/);
    expect(noticeFor(new ApiError(429, 'rate_limited', 'x', 12))).toContain('12 s');
    expect(noticeFor(new ApiError(413, 'too_large', 'x'))).toMatch(/too large/);
    expect(noticeFor(new ApiError(0, 'offline', 'x'))).toMatch(/reach the server/);
    expect(noticeFor(new ApiError(404, 'not_found', 'x'))).toBeNull();
  });
});

describe('the page and the policy', () => {
  it('refuses inline scripts, styles, handlers and external URLs', () => {
    expect(checkHtml('<script type="module" src="/assets/a.js"></script><link rel="stylesheet" href="/assets/a.css">')).toEqual([]);
    expect(checkHtml('<script>alert(1)</script>')).toContain('an inline script');
    expect(checkHtml('<div style="color:red"></div>')).toContain('a style attribute');
    expect(checkHtml('<style>a{}</style>')).toContain('a <style> element');
    expect(checkHtml('<button onclick="x()"></button>')).toContain('an event handler attribute');
    expect(checkHtml('<script src="https://cdn.example.com/x.js"></script>')).toContain('an external URL');
  });
});
