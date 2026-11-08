/**
 * The board: tiles from the account's widgets, packed on the grid, with the liquid drag (the others flow out of the
 * way, the dropped one settles with one soft overshoot) and the refraction maps. A drop saves the layout to board.
 */
import type { Widget } from '@app/contracts';
import { $, $$, clamp, cssNum, esc, mk, raf2, reduced, root, setHtml } from './dom.ts';
import { IC } from './icons.ts';
import { DESKTOP_COLS, PHONE_COLS, canonical, dimsOf, orderFromBoard, pack, placesFor, type Rect } from './layout.ts';
import { displayHtml, miniHtml, tileName, type RenderCtx } from './widgets.ts';

type Place = Widget['spec']['place'];

/** A folder change the board shows before the server has it. */
export interface LocalChange {
  /** Where tiles go, by widget id. */
  places: Map<string, Place>;
  /** A folder made here: it has a temporary id until the server makes it. */
  folder?: Widget;
  /** A folder whose last card left. */
  gone?: string;
  /** A folder's new name. */
  title?: { id: string; title: string };
}

/** The server's board with the changes still waiting laid over it. */
export function withLocal(server: readonly Widget[], local: readonly LocalChange[]): readonly Widget[] {
  if (!local.length) return server;
  let out = [...server];
  for (const c of local) {
    if (c.folder) out.push(c.folder);
    out = out
      .filter((w) => w.spec.widget_id !== c.gone)
      .map((w) => {
        const place = c.places.get(w.spec.widget_id);
        const title = c.title?.id === w.spec.widget_id ? c.title.title : undefined;
        if (!place && title === undefined) return w;
        return { ...w, spec: { ...w.spec, ...(place && { place }), ...(title !== undefined && { title }) } } as Widget;
      });
  }
  return out;
}

export interface Placed extends Rect {
  x: number;
  y: number;
  W: number;
  H: number;
}

export const S = {
  widgets: new Map<string, Widget>(),
  order: [] as string[],
  kids: new Map<string, string[]>(),
  rects: new Map<string, Placed>(),
  cols: DESKTOP_COLS,
  cell: 100,
  gap: 12,
  tile: 76,
  u: 1,
  phone: false,
  rows: 0,
  brect: null as DOMRect | null,
  dt: 0,
  /** Tiles whose removal waits for its Undo offer to end: off the board here, still on the server. */
  hidden: new Set<string>(),
  /** The last board from the server, so a change here (hide, undo) can redraw without a fetch. */
  last: [] as readonly Widget[],
  /** Folder changes shown here and not answered yet (their Undo offer, then the call), laid over every board from the server. */
  local: [] as LocalChange[],
  /** A make-folder is on its way: a board from the server may already hold the new folder, which the answer will bring. */
  sending: 0,
};
/** The tile elements by widget id (grid tiles only; folder children live inside their folder). */
export const EL = new Map<string, HTMLElement>();

let board: HTMLElement;
let wrap: HTMLElement;
let slotEl: HTMLElement;

export interface BoardHooks {
  openMenu: (id: string) => void;
  openApp: (id: string) => void;
  openFolder: (id: string) => void;
  /** A tap on a number: How we got this; a tap on a News item: How we got this at that article. */
  openHow: (id: string, article?: string) => void;
  /** The user dropped a tile: the new desktop order to save. */
  saveOrder: (order: string[]) => void;
  closeSurface: (instant?: boolean) => void;
}
let hooks: BoardHooks;

/** What a folder drag asks for; actions.ts answers, with Undo. */
export interface FolderHooks {
  /** A card dropped on a card (a new folder) or on a folder. */
  drop: (card: string, target: string) => void;
  /** A card dragged out of an open folder, to this place in the grid's order. */
  takeOut: (card: string, folder: string, index: number) => void;
  rename: (folder: string, title: string) => void;
  /** Save a grid order while a folder change is still waiting, after that change. */
  saveOrder: (order: string[]) => void;
}
export let folderHooks: FolderHooks;
export const bindFolders = (h: FolderHooks) => {
  folderHooks = h;
};

const dims = (id: string) => dimsOf(S.widgets.get(id)!.spec, S.cols);
const dims8 = (id: string) => dimsOf(S.widgets.get(id)!.spec, DESKTOP_COLS);
const sizeCls = (w: Widget) => (w.spec.kind === 'display' ? `w--${w.spec.size.toLowerCase()}` : '');

/** Titles of the board's one-market cards, by event key, so other widgets can name an event. */
function renderCtx(): RenderCtx {
  const titles = new Map<string, string>();
  const events = new Map<string, string>();
  for (const w of S.widgets.values()) {
    const s = w.spec;
    if (s.kind !== 'display') continue;
    const keys = s.params.event_keys ?? [];
    // A game's title from its one-market card ("Chiefs at Bills"); a larger Market display may say "Chiefs beat the Bills".
    if (keys.length === 1 && s.type === 'probability' && (s.size === 'S' || !titles.has(keys[0]!))) titles.set(keys[0]!, s.title);
    // Which game each market is: one game's markets, or a list of games with one market each.
    s.market_ids.forEach((m, i) => {
      const k = keys.length === 1 ? keys[0] : keys.length === s.market_ids.length ? keys[i] : undefined;
      if (k && !events.has(m)) events.set(m, k);
    });
  }
  return { titles, events };
}

// ---------- refraction: one lens map per glass size, cut to that size, written as data URLs ----------

const lensCache: Record<string, string> = {};
function lensMap(W: number, H: number, r: number, band: number) {
  const key = [W, H, r, band].join('x');
  if (lensCache[key]) return lensCache[key];
  const c = mk('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const im = g.createImageData(W, H);
  const d = im.data;
  r = Math.min(r, W / 2, H / 2);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = x + 0.5 - W / 2;
      const py = y + 0.5 - H / 2;
      const qx = Math.abs(px) - (W / 2 - r);
      const qy = Math.abs(py) - (H / 2 - r);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const dist = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
      let nx = 0;
      let ny = 0;
      if (ox > 0 || oy > 0) {
        const l = Math.hypot(ox, oy);
        nx = (ox / l) * Math.sign(px);
        ny = (oy / l) * Math.sign(py);
      } else if (qx > qy) nx = Math.sign(px);
      else ny = Math.sign(py);
      const t = clamp(-dist / band, 0, 1);
      const m = (1 - t) * (1 - t);
      const i = (y * W + x) * 4;
      d[i] = 128 - 127 * m * nx;
      d[i + 1] = 128 - 127 * m * ny;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  g.putImageData(im, 0, 0);
  return (lensCache[key] = c.toDataURL('image/png'));
}
function setLens(id: string, w: number, h: number, r: number) {
  const f = document.getElementById(id);
  if (!f || w < 16 || h < 16) return;
  f.querySelector('feImage')!.setAttribute('href', lensMap(Math.round(w), Math.round(h), Math.round(r), Math.round(Math.min(24, Math.min(w, h) / 4))));
}
export function buildLens() {
  if (root.dataset.refract !== '1') return;
  const span = (n: number) => n * S.cell + (n - 1) * S.gap;
  const rw = cssNum('--r-widget', 24);
  const rp = cssNum('--r-panel', 28);
  const c4 = Math.min(4, S.cols);
  const c8 = Math.min(8, S.cols);
  setLens('lens-s', span(2), span(2), rw);
  setLens('lens-m', span(c4), span(2), rw);
  setLens('lens-l', span(c4), span(4), rw);
  setLens('lens-xl', span(c8), span(4), rw);
  const bar = $('.bar');
  setLens('lens-bar', bar.offsetWidth, bar.offsetHeight, rp);
  const chat = $('#chat');
  if (!S.phone) setLens('lens-chat', chat.offsetWidth, chat.offsetHeight, rp);
}
export function updateRefraction() {
  const sc = (clamp(cssNum('--refraction', 0.45), 0, 1) * 44).toFixed(1);
  for (const e of $$('feDisplacementMap')) e.setAttribute('scale', sc);
}

// ---------- layout ----------

function measure() {
  S.phone = innerWidth <= 720;
  root.dataset.layout = S.phone ? 'phone' : 'desktop';
  S.gap = clamp(cssNum('--gap', 12), 8, 18);
  const cs = getComputedStyle(wrap);
  const aw = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  // A narrow board area (a small desktop window beside the chat) takes the phone's 4 columns and scrolls.
  S.cols = S.phone || aw < 640 ? PHONE_COLS : DESKTOP_COLS;
  let cell = (aw - S.gap * (S.cols - 1)) / S.cols;
  if (S.cols === DESKTOP_COLS) cell = Math.min(cell, (ah - S.gap * 6) / 7);
  S.cell = Math.floor(clamp(cell, 54, 132));
  S.tile = Math.round(S.cell * 0.76);
  S.u = clamp(S.cell / 100, 0.92, 1.25);
  board.style.setProperty('--cell', S.cell + 'px');
  board.style.setProperty('--tile', S.tile + 'px');
  board.style.setProperty('--u', S.u.toFixed(3));
  S.brect = null;
}

export function place(o: { stagger?: boolean } = {}) {
  const { rects, rows } = pack(S.order, dims, S.cols);
  S.rows = rows;
  const step = S.cell + S.gap;
  const dr = D?.active ? D.id : null;
  board.style.width = S.cols * S.cell + (S.cols - 1) * S.gap + 'px';
  board.style.height = Math.max(S.rows * step - S.gap, 0) + 'px';
  const prev = S.rects;
  S.rects = new Map();
  for (const [id, r] of rects) S.rects.set(id, { ...r, x: r.c * step, y: r.r * step, W: r.w * S.cell + (r.w - 1) * S.gap, H: r.h * S.cell + (r.h - 1) * S.gap });
  const sl = dr ? S.rects.get(dr) : null;
  // A phone during a drag: only the two tiles nearest the gap glide (design.md section 13); the others go straight there.
  const glide = S.phone && sl ? nearestMoving(sl, prev) : null;
  for (const [id, r] of S.rects) {
    const w = EL.get(id);
    if (!w) continue;
    w.style.setProperty('--W', r.W + 'px');
    w.style.setProperty('--H', r.H + 'px');
    w.style.width = r.W + 'px';
    w.style.height = r.H + 'px';
    if (id === dr) continue;
    if (o.stagger && sl) w.style.setProperty('--delay', Math.min(170, Math.hypot(r.x - sl.x, r.y - sl.y) * 0.18).toFixed(0) + 'ms');
    if (glide && !glide.has(id)) w.classList.add('no-glide');
    w.style.transform = `translate3d(${r.x}px,${r.y}px,0)`;
  }
  if (o.stagger) {
    clearTimeout(S.dt);
    S.dt = window.setTimeout(() => EL.forEach((w) => w.style.removeProperty('--delay')), 1100);
  }
  if (D?.active) moveSlot();
  S.brect = null;
  if (glide) raf2(() => EL.forEach((w) => w.classList.remove('no-glide')));
}

/** The two tiles nearest the gap whose place changes on this reflow. */
function nearestMoving(sl: Placed, prev: Map<string, Placed>) {
  const moving = [...S.rects].filter(([id, r]) => {
    const p = prev.get(id);
    return id !== D!.id && p && (p.x !== r.x || p.y !== r.y);
  });
  moving.sort(([, a], [, b]) => Math.hypot(a.x - sl.x, a.y - sl.y) - Math.hypot(b.x - sl.x, b.y - sl.y));
  return new Set(moving.slice(0, 2).map(([id]) => id));
}

export function layoutAll() {
  board.classList.add('no-anim');
  measure();
  place();
  buildLens();
  raf2(() => board.classList.remove('no-anim'));
}

// ---------- tiles ----------

const menuBtn = (n: string) => `<button class="w-menu-btn" type="button" aria-label="Menu for ${esc(n)}" aria-haspopup="menu">${IC.dots}</button>`;

function tileHtml(w: Widget): string {
  const s = w.spec;
  if (s.kind === 'display') return `<i class="g-clip"></i><i class="w-spot"></i><i class="w-shimmer"></i><div class="w-in">${displayHtml(w, renderCtx())}</div>${menuBtn(s.title)}`;
  if (s.kind === 'app') return `<div class="a-tile"><i class="g-clip"></i>${IC[s.app]}${menuBtn(tileName(w))}</div><span class="a-label">${esc(tileName(w))}</span>`;
  const mini = (S.kids.get(s.widget_id) ?? [])
    .slice(0, 4)
    .map((k) => S.widgets.get(k))
    .filter((k): k is Widget => !!k)
    .map(miniHtml)
    .join('');
  return `<div class="f-tile"><i class="g-clip"></i><div class="f-grid">${mini}</div>${menuBtn(s.title)}</div><span class="a-label">${esc(s.title)}</span>`;
}

function tileClass(w: Widget) {
  const kind = w.spec.kind;
  const state = w.state === 'refreshing' ? ' is-refreshing' : '';
  return kind === 'display' ? `w w--display ${sizeCls(w)}${state}` : `w w--${kind}`;
}

function makeTile(w: Widget): HTMLElement {
  const el = mk('div');
  el.dataset.id = w.spec.widget_id;
  el.dataset.kind = w.spec.kind;
  el.tabIndex = 0;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', tileName(w));
  el.className = tileClass(w);
  setHtml(el, tileHtml(w));
  return el;
}

/** Re-renders a tile's inside in place (new numbers), keeping its position and its motion classes. */
export function refreshTile(id: string) {
  const el = EL.get(id);
  const w = S.widgets.get(id);
  if (!el || !w) return;
  const keep = ['is-lifted', 'is-settling', 'is-new', 'is-hot', 'is-morph', 'is-out', 'is-merge', 'has-live', 'is-running'].filter((c) => el.classList.contains(c));
  if (w.spec.kind === 'display') {
    const inner = el.querySelector('.w-in');
    if (inner) setHtml(inner, displayHtml(w, renderCtx()));
  } else setHtml(el, tileHtml(w));
  el.className = tileClass(w) + (keep.length ? ' ' + keep.join(' ') : '');
  el.setAttribute('aria-label', tileName(w));
}

/** First mount: every tile pours in, staggered. */
export function mount(widgets: readonly Widget[]) {
  board = $('#board');
  wrap = $('#board-wrap');
  slotEl = $('#slot');
  setData(widgets);
  for (const id of S.order) {
    const el = makeTile(S.widgets.get(id)!);
    EL.set(id, el);
    board.appendChild(el);
  }
  board.classList.add('no-anim');
  measure();
  place();
  buildLens();
  void board.offsetWidth;
  raf2(() => board.classList.remove('no-anim'));
  let i = 0;
  for (const [id, el] of EL) {
    const w = S.widgets.get(id)!;
    el.style.setProperty('--ed', (w.state === 'new' ? 1150 : i * 55) + 'ms');
    el.classList.add('is-new');
    i++;
  }
  setTimeout(() => EL.forEach((el) => {
    el.classList.remove('is-new');
    el.style.removeProperty('--ed');
  }), 2500);
}

function setData(widgets: readonly Widget[]) {
  S.last = widgets;
  const view = withLocal(widgets, S.local);
  S.widgets = new Map(view.map((w) => [w.spec.widget_id, w]));
  const { order, kids } = orderFromBoard(view);
  S.order = order.filter((id) => !S.hidden.has(id));
  S.kids = kids;
}

/** Take a tile off the board here (it drains, the others flow), or put it back (it pours in where it was). */
export function hideTile(id: string, hide: boolean) {
  if (hide) S.hidden.add(id);
  else S.hidden.delete(id);
  applyBoard(S.last);
}

/** One widget changed on the server (a resize answers with it): redraw with it. */
export function upsert(w: Widget) {
  applyBoard(S.last.map((o) => (o.spec.widget_id === w.spec.widget_id ? w : o)));
}

/** Save the grid as it now packs (after a size change), so a reload rebuilds this board. */
export function saveLayout() {
  const order = canonical(S.order, dims8);
  const moved = order.join() !== S.order.join();
  S.order = order;
  if (moved) place({ stagger: true });
  persist(order);
}

/** Save an order: straight away, or behind the folder change still waiting (it may name a folder with no id yet). */
function persist(order: string[]) {
  if (S.local.length) folderHooks.saveOrder(order);
  else hooks.saveOrder(order);
}

/** Show a change now. */
export function showLocal(c: LocalChange) {
  S.local.push(c);
  applyBoard(S.last);
}

/** Take a shown change back (Undo, or the call failed). */
export function dropLocal(c: LocalChange) {
  const i = S.local.indexOf(c);
  if (i < 0) return;
  S.local.splice(i, 1);
  applyBoard(S.last);
}

/** The server answered a change: its board replaces the change. */
export function settleLocal(c: LocalChange, server: readonly Widget[]) {
  const i = S.local.indexOf(c);
  if (i >= 0) S.local.splice(i, 1);
  applyBoard(server);
}

/** The server made a folder: everything that names the temporary id names the real one, and the tile stays as it is. */
export function adoptFolder(tmp: string, real: string) {
  const fix = (id: string) => (id === tmp ? real : id);
  const el = EL.get(tmp);
  if (el) {
    EL.delete(tmp);
    EL.set(real, el);
    el.dataset.id = real;
  }
  S.order = S.order.map(fix);
  if (D) {
    D.id = fix(D.id);
    D.startOrder = D.startOrder.map(fix);
    if (D.hover) D.hover = fix(D.hover);
    if (D.merge) D.merge = fix(D.merge);
  }
  for (const c of S.local) {
    c.places = new Map([...c.places].map(([k, p]) => [fix(k), 'folder_id' in p ? { ...p, folder_id: fix(p.folder_id) } : p]));
    if (c.gone) c.gone = fix(c.gone);
    if (c.title) c.title.id = fix(c.title.id);
  }
}

/** A fresh board from the server. Waits while a make-folder is on its way: the answer brings the new folder. */
export function reconcile(widgets: readonly Widget[]) {
  if (!S.sending) applyBoard(widgets);
}

/**
 * Tiles whose data changed are re-rendered in place; new tiles pour in, removed ones drain away; a different order
 * (another tab) glides. While the user drags, the server's order waits: the drop saves the user's own.
 */
function applyBoard(widgets: readonly Widget[]) {
  const before = new Map(S.widgets);
  const prevOrder = S.order;
  setData(widgets);
  if (D?.active) S.order = prevOrder.filter((id) => S.widgets.has(id)).concat(S.order.filter((id) => !prevOrder.includes(id)));
  for (const [id, el] of EL) {
    if (S.widgets.has(id) && S.order.includes(id)) continue;
    EL.delete(id);
    el.classList.add('is-out');
    setTimeout(() => el.remove(), reduced() ? 220 : 300);
  }
  for (const id of S.order) {
    const w = S.widgets.get(id)!;
    const old = before.get(id);
    if (!EL.has(id)) {
      const el = makeTile(w);
      EL.set(id, el);
      board.appendChild(el);
      el.classList.add('is-new');
      setTimeout(() => el.classList.remove('is-new'), 1600);
    } else if (!old || old.updated_at !== w.updated_at || old.state !== w.state || JSON.stringify(old.spec) !== JSON.stringify(w.spec) || w.spec.kind === 'folder') refreshTile(id);
  }
  place({ stagger: prevOrder.join() !== S.order.join() });
}

/** A run started or a refresh was asked: the liquid shimmer, until the result lands. */
export function shimmer(id: string, on: boolean) {
  EL.get(id)?.classList.toggle('is-refreshing', on);
}

// ---------- drag: mouse after 5 px, touch after a 380 ms hold; the others flow, the dropped one settles ----------

interface Drag {
  w: HTMLElement;
  id: string;
  pid: number;
  type: string;
  x0: number;
  y0: number;
  lx: number;
  ly: number;
  active: boolean;
  timer: number;
  raf: number;
  dwell: number;
  left: number;
  top: number;
  scroll0: number;
  wrect: DOMRect | null;
  gx: number;
  gy: number;
  cx: number;
  cy: number;
  hover: string | null;
  /** The pointer is over the middle of the hover tile: this tile would become a folder. */
  middle: boolean;
  /** The tile the drop would merge with (armed after a short hover). */
  merge: string | null;
  lastSwap: { x: number; y: number } | null;
  startOrder: string[];
}
let D: Drag | null = null;
/** The hover that makes a folder, then the wait before a card under an edge swaps (a card or folder target). */
const MERGE_MS = 260;
const SWAP_MS = 240;
/** How much of a target counts as "over the middle": this share of it, at most 80 px across, so a big card's edges still reorder. */
const MIDDLE = 0.64;
const MIDDLE_MAX = 80;

function canMerge(card: string, target: string) {
  const a = S.widgets.get(card);
  const b = S.widgets.get(target);
  if (a?.spec.kind !== 'display' || !b) return false;
  return b.spec.kind === 'display' || (b.spec.kind === 'folder' && (S.kids.get(target)?.length ?? 0) < 24);
}

/** Show (or stop showing) that the hovered tile will become a folder. */
function arm(d: Drag, id: string | null) {
  if (d.merge === id) return;
  if (d.merge) EL.get(d.merge)?.classList.remove('is-merge');
  d.merge = id;
  if (id) EL.get(id)?.classList.add('is-merge');
}
let suppressUntil = 0;
export const isDragging = () => !!D?.active;

function startDrag() {
  const d = D!;
  clearTimeout(d.timer);
  d.active = true;
  const r = S.rects.get(d.id)!;
  const b = board.getBoundingClientRect();
  d.left = b.left;
  d.top = b.top;
  d.scroll0 = wrap.scrollTop;
  d.wrect = wrap.getBoundingClientRect();
  d.gx = d.x0 - (b.left + r.x);
  d.gy = d.y0 - (b.top + r.y);
  d.cx = r.x;
  d.cy = r.y;
  d.hover = null;
  d.middle = false;
  d.merge = null;
  d.lastSwap = null;
  d.startOrder = [...S.order];
  d.w.classList.add('is-lifted');
  board.classList.add('is-dragging');
  slotEl.classList.add('on');
  moveSlot();
  if (d.type !== 'mouse' && navigator.vibrate) navigator.vibrate(10);
  dragFrame();
}

function moveSlot() {
  const r = S.rects.get(D!.id)!;
  const w = S.widgets.get(D!.id)!;
  let x = r.x;
  let y = r.y;
  let W = r.W;
  let H = r.H;
  let rad = cssNum('--r-widget', 24);
  if (w.spec.kind !== 'display') {
    x += (S.cell - S.tile) / 2;
    y += (S.cell - S.tile - 18) / 2;
    W = H = S.tile;
    rad = S.tile * 0.27;
  }
  const st = slotEl.style;
  st.transform = `translate3d(${x}px,${y}px,0)`;
  st.width = W + 'px';
  st.height = H + 'px';
  st.borderRadius = rad + 'px';
}

function dragFrame() {
  const d = D;
  if (!d || !d.active) return;
  d.raf = 0;
  const px = d.lx - d.left;
  const py = d.ly - d.top + (wrap.scrollTop - d.scroll0);
  d.cx = px - d.gx;
  d.cy = py - d.gy;
  d.w.style.transform = `translate3d(${d.cx}px,${d.cy}px,0)`;
  const s = S.rects.get(d.id)!;
  if (px >= s.x && px <= s.x + s.W && py >= s.y && py <= s.y + s.H) {
    d.hover = null;
    d.middle = false;
    arm(d, null);
    clearTimeout(d.dwell);
  } else {
    let hit: string | null = null;
    for (const [id, r] of S.rects)
      if (id !== d.id && px >= r.x && px <= r.x + r.W && py >= r.y && py <= r.y + r.H) {
        hit = id;
        break;
      }
    const merges = !!hit && canMerge(d.id, hit);
    const r = hit ? S.rects.get(hit)! : null;
    const middle = merges && Math.abs(px - (r!.x + r!.W / 2)) < Math.min(r!.W * MIDDLE, MIDDLE_MAX) / 2 && Math.abs(py - (r!.y + r!.H / 2)) < Math.min(r!.H * MIDDLE, MIDDLE_MAX) / 2;
    if (hit !== d.hover || middle !== d.middle) {
      d.hover = hit;
      d.middle = middle;
      arm(d, null);
      clearTimeout(d.dwell);
      if (hit) d.dwell = window.setTimeout(() => (middle ? arm(d, hit) : commitSwap(hit)), middle ? MERGE_MS : merges ? SWAP_MS : 110);
    }
  }
  const edge = d.ly < d.wrect!.top + 56 ? -1 : d.ly > d.wrect!.bottom - 56 ? 1 : 0;
  if (edge && wrap.scrollHeight > wrap.clientHeight + 2) {
    wrap.scrollTop += edge * 9;
    d.raf = requestAnimationFrame(dragFrame);
  }
}

function commitSwap(hit: string) {
  const d = D;
  if (!d || !d.active || d.hover !== hit) return;
  // 28 px of pointer travel between two swaps: without it a small tile over a big one flips forever.
  if (d.lastSwap && Math.hypot(d.lx - d.lastSwap.x, d.ly - d.lastSwap.y) < 28) {
    d.hover = null;
    return;
  }
  const from = S.order.indexOf(d.id);
  const to = S.order.indexOf(hit);
  if (from < 0 || to < 0) return;
  S.order.splice(from, 1);
  S.order.splice(to, 0, d.id);
  d.lastSwap = { x: d.lx, y: d.ly };
  d.hover = null;
  d.middle = false;
  arm(d, null);
  place({ stagger: true });
}

/** The release: a damped spring as a linear() easing, with one overshoot of --wobble px. */
function springEase(os: number) {
  if (!CSS.supports('transition-timing-function', 'linear(0, 1)')) return 'cubic-bezier(.2,.9,.3,1.1)';
  const ln = Math.log(os);
  const z = -ln / Math.sqrt(Math.PI * Math.PI + ln * ln);
  const wd = Math.sqrt(1 - z * z);
  const T = 5.2 / z;
  const pts: number[] = [];
  for (let i = 0; i <= 28; i++) {
    const t = (i / 28) * T;
    pts.push(+(1 - Math.exp(-z * t) * (Math.cos(wd * t) + (z / wd) * Math.sin(wd * t))).toFixed(4));
  }
  pts[28] = 1;
  return `linear(${pts.join(', ')})`;
}

function endDrag() {
  const d = D!;
  D = null;
  clearTimeout(d.timer);
  clearTimeout(d.dwell);
  if (!d.active) return;
  suppressUntil = performance.now() + 350;
  const w = d.w;
  const r = S.rects.get(d.id)!;
  const target = d.merge;
  if (target) {
    // It merges into the target where the drop was, and the rest of the board goes back to where it was.
    EL.get(target)?.classList.remove('is-merge');
    const t = S.rects.get(target)!;
    board.classList.remove('is-dragging');
    slotEl.classList.remove('on');
    EL.delete(d.id);
    w.classList.remove('is-lifted');
    w.classList.add('is-merging');
    w.style.transform = `translate3d(${t.x + t.W / 2 - r.W / 2}px,${t.y + t.H / 2 - r.H / 2}px,0)`;
    setTimeout(() => w.remove(), reduced() ? 220 : 340);
    S.order = d.startOrder;
    folderHooks.drop(d.id, target);
    return;
  }
  const dist = Math.hypot(r.x - d.cx, r.y - d.cy);
  board.classList.remove('is-dragging');
  slotEl.classList.remove('on');
  w.style.setProperty('--settle-e', springEase(clamp(cssNum('--wobble', 6) / Math.max(dist, 30), 0.015, 0.12)));
  w.style.setProperty('--settle-t', clamp(520 + dist * 0.5, 560, 900) + 'ms');
  w.classList.remove('is-lifted');
  w.classList.add('is-settling');
  w.style.transform = `translate3d(${r.x}px,${r.y}px,0)`;
  setTimeout(() => {
    w.classList.remove('is-settling');
    w.style.removeProperty('--settle-e');
    w.style.removeProperty('--settle-t');
  }, 1000);
  if (d.startOrder.join() !== S.order.join()) {
    // Store the order whose desktop packing reads back as itself, so a reload rebuilds this board.
    const order = canonical(S.order, dims8);
    const moved = order.join() !== S.order.join();
    S.order = order;
    if (moved) place({ stagger: true });
    persist(order);
  }
}

export const desktopPlaces = (order: string[]) => placesFor(order, dims8);
/** The grid's places without one tile (it moves into a folder), in the order that reads back as itself. */
export const placesWithout = (id: string) => placesFor(canonical(S.order.filter((o) => o !== id), dims8), dims8);
/** The grid's places for an order, in the order that reads back as itself. */
export const placesOf = (order: string[]) => placesFor(canonical(order, dims8), dims8);

/** Where in the grid's order a card dropped at this screen point goes: before the nearest tile, or after it if past its middle. */
export function indexAt(x: number, y: number) {
  const b = board.getBoundingClientRect();
  const px = x - b.left;
  const py = y - b.top;
  let best = S.order.length;
  let nearest = Infinity;
  S.order.forEach((id, i) => {
    const r = S.rects.get(id);
    if (!r) return;
    const cx = r.x + r.W / 2;
    const cy = r.y + r.H / 2;
    const dist = Math.hypot(px - cx, py - cy);
    if (dist >= nearest) return;
    nearest = dist;
    best = i + (py > r.y + r.H || (py >= r.y && px > cx) ? 1 : 0);
  });
  return best;
}

// ---------- events ----------

let hot: HTMLElement | null = null;
function place1(spot: HTMLElement, e: PointerEvent, w: HTMLElement) {
  const b = S.brect ?? (S.brect = board.getBoundingClientRect());
  const r = S.rects.get(w.dataset.id!);
  if (!r) return;
  spot.style.transform = `translate3d(${e.clientX - b.left - r.x}px,${e.clientY - b.top - r.y}px,0)`;
}

export function bindBoard(h: BoardHooks) {
  hooks = h;
  board.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest('.w-menu-btn')) return;
    const w = t.closest<HTMLElement>('.w');
    if (!w || !EL.has(w.dataset.id!)) return;
    D = {
      w,
      id: w.dataset.id!,
      pid: e.pointerId,
      type: e.pointerType,
      x0: e.clientX,
      y0: e.clientY,
      lx: e.clientX,
      ly: e.clientY,
      active: false,
      timer: 0,
      raf: 0,
      dwell: 0,
      left: 0,
      top: 0,
      scroll0: 0,
      wrect: null,
      gx: 0,
      gy: 0,
      cx: 0,
      cy: 0,
      hover: null,
      middle: false,
      merge: null,
      lastSwap: null,
      startOrder: [],
    };
    if (e.pointerType !== 'mouse') D.timer = window.setTimeout(() => {
      if (D && !D.active) startDrag();
    }, 380);
  });
  addEventListener('pointermove', (e) => {
    if (!D || e.pointerId !== D.pid) return;
    D.lx = e.clientX;
    D.ly = e.clientY;
    if (!D.active) {
      const dist = Math.hypot(D.lx - D.x0, D.ly - D.y0);
      if (D.type === 'mouse') {
        if (dist > 5) startDrag();
      } else if (dist > 10) {
        clearTimeout(D.timer);
        D = null;
      }
      return;
    }
    if (!D.raf) D.raf = requestAnimationFrame(dragFrame);
  });
  addEventListener('pointerup', (e) => {
    if (D && e.pointerId === D.pid) endDrag();
  });
  addEventListener('pointercancel', (e) => {
    if (D && e.pointerId === D.pid) endDrag();
  });
  addEventListener('touchmove', (e) => {
    if (D?.active) e.preventDefault();
  }, { passive: false });
  board.addEventListener('contextmenu', (e) => {
    if (D || (e as PointerEvent).pointerType === 'touch') e.preventDefault();
  });

  board.addEventListener('click', (e) => {
    if (performance.now() < suppressUntil) return;
    const t = e.target as Element;
    const w = t.closest<HTMLElement>('.w');
    if (!w) return;
    const it = S.widgets.get(w.dataset.id!);
    if (!it) return;
    if (t.closest('.w-menu-btn')) h.openMenu(it.spec.widget_id);
    else if (it.spec.kind === 'display' && t.closest('[data-cnd]')) h.openHow(it.spec.widget_id, t.closest<HTMLElement>('[data-cnd]')!.dataset.cnd);
    else if (it.spec.kind === 'display' && t.closest('.num')) h.openHow(it.spec.widget_id);
    else if (it.spec.kind === 'app') h.openApp(it.spec.widget_id);
    else if (it.spec.kind === 'folder') h.openFolder(it.spec.widget_id);
  });
  board.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const w = (e.target as Element).closest<HTMLElement>('.w');
    if (!w || e.target !== w) return;
    e.preventDefault();
    const it = S.widgets.get(w.dataset.id!);
    if (!it) return;
    if (it.spec.kind === 'app') h.openApp(it.spec.widget_id);
    else if (it.spec.kind === 'folder') h.openFolder(it.spec.widget_id);
    else h.openMenu(it.spec.widget_id);
  });
  // The soft highlight that follows the pointer, with a lag.
  board.addEventListener('pointermove', (e) => {
    if (D?.active) return;
    const w = (e.target as Element).closest?.<HTMLElement>('.w--display') ?? null;
    const spot = w?.querySelector<HTMLElement>('.w-spot') ?? null;
    if (w !== hot) {
      hot?.classList.remove('is-hot');
      hot = w;
      if (hot && spot) {
        spot.style.transition = 'none';
        place1(spot, e, hot);
        void spot.offsetWidth;
        spot.style.transition = '';
        hot.classList.add('is-hot');
      }
    } else if (hot && spot) place1(spot, e, hot);
  });
  board.addEventListener('pointerleave', () => {
    hot?.classList.remove('is-hot');
    hot = null;
  });
  wrap.addEventListener('scroll', () => {
    S.brect = null;
  }, { passive: true });
  let rzT = 0;
  addEventListener('resize', () => {
    clearTimeout(rzT);
    rzT = window.setTimeout(() => {
      h.closeSurface(true);
      layoutAll();
    }, 120);
  });
}
