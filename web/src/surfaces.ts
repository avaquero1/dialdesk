/**
 * Surfaces: the ⋯ menu, the app sheets, the open folder and the Look sheet. Each pours from where it started (the
 * button or the tile) to its final box and drains back. Content is laid out at the final size; only the box moves.
 *
 * Not built yet (the next step): the menu's actions, the chat, the trust page, the run trace, Accounts and Catalog.
 * They show as greyed items or a "next build" note, never as fake results.
 */
import type { Account, Widget, WidgetResult } from '@app/contracts';
import { $, $$, clamp, css, cssNum, esc, mk, reduced, root } from './dom.ts';
import { EL, S, buildLens } from './board.ts';
import { IC, type IconName } from './icons.ts';
import { L, THEMES, mqDark, resolveMode, setLook, themeHue } from './look.ts';
import { cardHtml, fmtNum, fmtTime } from './widgets.ts';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}
type Surface = HTMLDivElement & { _set: (b: Box) => void; _from: () => Box };

let layer: HTMLElement;
let scrim: HTMLElement;
let toastEl: HTMLElement;
let SF: Surface | null = null;
let toastT = 0;

export interface SurfaceHooks {
  account: () => Account | null;
  logout: () => void;
  closeChat: () => void;
}
let hooks: SurfaceHooks;

export function initSurfaces(h: SurfaceHooks) {
  hooks = h;
  layer = $('#layer');
  scrim = $('#scrim');
  toastEl = $('#toast');
  scrim.addEventListener('click', () => {
    closeSurface();
    hooks.closeChat();
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSurface();
      hooks.closeChat();
    }
  });
  $('#look-btn').addEventListener('click', () => (lookOpen() ? closeSurface() : openLook()));
  $('#avatar').addEventListener('click', () => openAccount());
}

export const surfaceOpen = () => !!SF;
const lookOpen = () => !!SF?.querySelector('#lk-range');

export function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastT);
  toastT = window.setTimeout(() => toastEl.classList.remove('on'), 2600);
}

const boxOf = (b: { left: number; top: number; width: number; height: number }, r: number): Box => ({ x: b.left, y: b.top, w: b.width, h: b.height, r });

interface Open {
  cls: string;
  html: string;
  w: number;
  from: Box;
  fromFn?: () => Box;
  place: (natural: number) => Box;
  alignR?: boolean;
  clear?: boolean;
  after?: (s: Surface) => void;
}

function openSurface(o: Open): Surface {
  if (SF) closeSurface(true);
  const s = mk('div', `surface ${o.cls}${o.alignR ? ' align-r' : ''}`) as Surface;
  const inner = mk('div', 's-in', o.html);
  const set = (b: Box) => {
    s.style.transform = `translate3d(${b.x}px,${b.y}px,0)`;
    s.style.width = b.w + 'px';
    s.style.height = b.h + 'px';
    s.style.borderRadius = b.r + 'px';
  };
  s.appendChild(inner);
  inner.style.width = o.w + 'px';
  s.style.transition = 'none';
  set(o.from);
  layer.appendChild(s);
  const to = o.place(inner.offsetHeight);
  inner.style.width = to.w + 'px';
  inner.style.height = to.h + 'px';
  void s.offsetWidth;
  s.style.removeProperty('transition');
  s.classList.add('is-open');
  set(to);
  s._set = set;
  s._from = o.fromFn ?? (() => o.from);
  scrim.className = 'scrim on' + (o.clear ? ' clear' : '');
  SF = s;
  o.after?.(s);
  return s;
}

export function closeSurface(instant?: boolean) {
  const s = SF;
  if (!s) return;
  SF = null;
  scrim.classList.remove('on');
  if (instant) {
    s.remove();
    return;
  }
  s.classList.remove('is-open');
  s.classList.add('is-closing');
  s._set(s._from());
  setTimeout(() => s.remove(), reduced() ? 260 : 1100);
}

function panel(kind: string, html: string, o: { w?: number; at?: 'right'; clear?: boolean; from: Box; fromFn?: () => Box; after?: (s: Surface) => void }) {
  const m = 12;
  const phone = S.phone;
  const W = phone ? innerWidth - 2 * m : Math.min(o.w ?? 520, innerWidth - 2 * m);
  return openSurface({
    cls: kind,
    html,
    w: W,
    clear: o.clear,
    from: o.from,
    fromFn: o.fromFn,
    after: (s) => {
      s.addEventListener('click', (e) => {
        if ((e.target as Element).closest('[data-close]')) closeSurface();
      });
      o.after?.(s);
    },
    place: (nat) => {
      const h = Math.min(nat, innerHeight - 2 * m - (phone ? 20 : 0));
      const r = cssNum('--r-panel', 28);
      let x = (innerWidth - W) / 2;
      let y = Math.max(m, (innerHeight - h) / 2);
      if (phone) {
        x = m;
        y = innerHeight - h - m;
      } else if (o.at === 'right') {
        x = innerWidth - W - 16;
        y = 84;
      }
      return { x, y, w: W, h, r };
    },
  });
}

const rz = (i: number) => ` rz"${css(`--i:${i}`)}`;
const closeBtn = (i: number) => `<button class="iconbtn${rz(i)} type="button" data-close aria-label="Close">${IC.close}</button>`;
const sheetHead = (t: string, sub?: string) => `<div class="sh-head${rz(0)}><h2>${esc(t)}</h2>${closeBtn(0)}</div>` + (sub ? `<p class="sh-sub${rz(1)}>${esc(sub)}</p>` : '');
const rowi = (ic: IconName, t: string, s: string, right: string, i: number) =>
  `<div class="rowitem${rz(i)}><span class="ic">${IC[ic]}</span><div class="grow"><div class="t">${esc(t)}</div><div class="s">${esc(s)}</div></div>${right}</div>`;
/** A plain note for a part that is not built yet. */
const nextBuild = (what: string, i: number) => `<div class="stub-note${rz(i)}><b>Next build.</b> ${esc(what)}</div>`;
const tileFrom = (id: string) => {
  const t = EL.get(id)?.querySelector('.a-tile, .f-tile');
  return t ? boxOf(t.getBoundingClientRect(), S.tile * 0.27) : boxOf({ left: innerWidth / 2 - 30, top: innerHeight / 2 - 30, width: 60, height: 60 }, 16);
};

// ---------- the ⋯ menu (opens on every tile; its actions arrive in the next step) ----------

function menuHTML(w: Widget) {
  let i = 0;
  const row = (ic: IconName, label: string) =>
    `<button class="mi${rz(i++)} type="button" aria-disabled="true">${IC[ic]}<span class="grow">${esc(label)}</span></button>`;
  const size = w.spec.kind === 'display' ? w.spec.size : null;
  const sizes = (['S', 'M', 'L', 'XL'] as const).map((z) => `<button type="button" aria-pressed="${size === z}" aria-disabled="true">${z}</button>`).join('');
  return (
    row('chat', 'Tune with chat') +
    row('refresh', 'Refresh now') +
    `<div class="mi mi--size${rz(i++)} aria-disabled="true">${IC.size}<span class="grow">Size</span><span class="seg" role="group" aria-label="Size">${sizes}</span></div>` +
    row('doc', 'Sources and receipts') +
    row('folder', 'Move to folder…') +
    '<hr>' +
    row('drop', 'Clear all') +
    row('trash', 'Remove from board') +
    `<p class="mi-note${rz(i++)}>These actions arrive in the next build. Drag a tile to move it.</p>`
  );
}

export function openMenu(id: string) {
  const w = S.widgets.get(id);
  const btn = EL.get(id)?.querySelector('.w-menu-btn');
  if (!w || !btn) return;
  const b = btn.getBoundingClientRect();
  const MW = Math.min(252, innerWidth - 24);
  const cur = () => {
    const bb = EL.get(id)?.querySelector('.w-menu-btn')?.getBoundingClientRect() ?? b;
    return boxOf(bb, bb.width / 2);
  };
  openSurface({
    cls: 'menu',
    alignR: true,
    html: menuHTML(w),
    w: MW,
    clear: true,
    from: boxOf(b, b.width / 2),
    fromFn: cur,
    place: (h) => ({ x: clamp(b.right - MW, 12, innerWidth - MW - 12), y: clamp(b.top - 4, 12, innerHeight - h - 12), w: MW, h, r: 22 }),
  });
}

// ---------- the open folder ----------

export function openFolder(id: string) {
  const f = S.widgets.get(id);
  if (!f) return;
  const kids = (S.kids.get(id) ?? []).map((k) => S.widgets.get(k)).filter((k): k is Widget => !!k);
  const cards = kids.map((k, i) => cardHtml(k, i + 2)).join('');
  panel(
    'folder-open',
    `<div class="sh-head${rz(0)}><h2 class="fo-title">${esc(f.spec.title)}</h2>${closeBtn(0)}</div>` +
      `<div class="sh-sub${rz(1)}>${kids.length} ${kids.length === 1 ? 'market' : 'markets'} · implied probability and 24 h move</div><div class="fo-grid">${cards}</div>`,
    { w: 540, from: tileFrom(id), fromFn: () => tileFrom(id) },
  );
}

// ---------- apps ----------

function receiptsBody() {
  const rows: string[] = [];
  let i = 2;
  for (const w of S.widgets.values()) {
    const r: WidgetResult | null = w.result;
    if (!r) continue;
    for (const n of r.numbers.slice(0, 4)) rows.push(rowi('receipts', w.spec.title, `${n.op.replace(/_/g, ' ')} ${fmtNum(n)} · ${fmtTime(r.created_at)}`, `<span class="mono">${esc(n.receipt_id)}</span>`, i++));
  }
  return (
    sheetHead('Receipts', 'Each number on the board points to the run that made it.') +
    (rows.length ? rows.join('') : `<div class="stub-note${rz(2)}>No receipts yet. The board shows cached exchange prices until each widget's first run.</div>`)
  );
}

function settingsBody() {
  const toggle = (k: string, on: boolean, label: string, sub: string, i: number) =>
    `<div class="rowitem${rz(i)}><div class="grow"><div class="t">${esc(label)}</div><div class="s">${esc(sub)}</div></div><button class="toggle" type="button" data-toggle="${k}" aria-pressed="${on}" aria-label="${esc(label)}"></button></div>`;
  return (
    sheetHead('Settings') +
    toggle('motion', reduced(), 'Reduced motion', 'Every change becomes a short fade', 1) +
    toggle('refract', root.dataset.refract === '1', 'Glass refraction', 'Bends the wallpaper at the glass edge (Chromium)', 2)
  );
}

const APP_BODY: Record<string, () => string> = {
  trust: () => sheetHead('Trust', 'Every task runs in a fresh sandbox.') + nextBuild("Today's sandboxes, blocked requests, killed runs and the signed audit head, from the audit log.", 2),
  receipts: receiptsBody,
  accounts: () => sheetHead('Accounts', 'The agent reads. It never trades for you.') + nextBuild('Connect Kalshi or Polymarket with a read-only key.', 2),
  catalog: () => sheetHead('Catalog', 'Add a widget to your board.') + nextBuild('Adding widgets by hand and through the chat.', 2),
  settings: settingsBody,
};

export function openApp(id: string) {
  const w = S.widgets.get(id);
  if (!w || w.spec.kind !== 'app') return;
  const body = APP_BODY[w.spec.app];
  if (!body) return;
  panel('sheet', body(), {
    w: 500,
    from: tileFrom(id),
    fromFn: () => tileFrom(id),
    after: (s) => {
      s.addEventListener('click', (e) => {
        const t = (e.target as Element).closest<HTMLElement>('[data-toggle]');
        if (!t) return;
        const on = t.getAttribute('aria-pressed') !== 'true';
        t.setAttribute('aria-pressed', String(on));
        if (t.dataset.toggle === 'motion') root.dataset.motion = on ? 'reduced' : 'full';
        else {
          root.dataset.refract = on ? '1' : '0';
          buildLens();
        }
        savePrefs();
      });
    },
  });
}

/** Per-device display preferences (not the look, which lives in the account). */
export function savePrefs() {
  try {
    localStorage.setItem('prefs', JSON.stringify({ motion: root.dataset.motion, refract: root.dataset.refract }));
  } catch {
    /* storage blocked: the preference lasts for this page only */
  }
}

// ---------- the account sheet (the avatar) ----------

function openAccount() {
  const a = hooks.account();
  const b = $('#avatar').getBoundingClientRect();
  const from = boxOf(b, b.height / 2);
  const who = a?.guest ? 'Guest' : (a?.email ?? '');
  const sub = a?.guest ? 'A guest board is deleted after a while. Sign up to keep yours.' : `Plan: ${a?.plan ?? 'free'}`;
  panel(
    'sheet',
    sheetHead('Account') +
      rowi('user', who, sub, '', 1) +
      `<div class="sh-sec${rz(2)}><button class="btn" type="button" id="logout-btn"><span class="ic-inline">${IC.logout}</span><span>Log out</span></button></div>`,
    {
      w: 420,
      at: 'right',
      clear: true,
      from,
      fromFn: () => from,
      after: (s) => $('#logout-btn', s).addEventListener('click', () => {
        closeSurface(true);
        hooks.logout();
      }),
    },
  );
}

// ---------- the Look sheet: theme, mode, hue ----------

const HUES = [32, 160, 200, 250, 290, 340];
const MODES = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['system', 'System'],
] as const;

function lookHTML() {
  return (
    sheetHead('Look') +
    `<div class="sh-sec${rz(1)}><h4>Theme</h4><div class="theme-grid">${THEMES.map((t) => `<button class="theme-chip" type="button" data-theme-set="${esc(t.id)}" aria-pressed="${t.id === L.theme}"><i class="tc-sw" data-theme="${esc(t.id)}" data-mode="${resolveMode()}"></i><span>${esc(t.name)}</span></button>`).join('')}</div></div>` +
    `<div class="sh-sec${rz(2)}><h4>Mode</h4><div class="seg" role="group" aria-label="Mode">${MODES.map((m) => `<button type="button" data-mode-set="${m[0]}" aria-pressed="${L.mode === m[0]}">${m[1]}</button>`).join('')}</div><p class="sh-note" id="lk-note"></p></div>` +
    `<div class="sh-sec${rz(3)}><h4>Hue</h4><div class="hue-row"><span class="sh-note">Tints the glass and the accent</span><b class="hue-val num" id="lk-hue"></b></div><input class="hue-range" id="lk-range" type="range" min="0" max="360" step="1" aria-label="Hue">` +
    `<div class="hue-sws">${HUES.map((h) => `<button class="hue-sw" type="button" data-hue="${h}" aria-label="Hue ${h}"${css(`background:oklch(.72 .15 ${h})`)}></button>`).join('')}</div><div><button class="btn btn--sm" type="button" id="lk-reset">Back to the theme's hue</button></div></div>`
  );
}

/** Refreshes an open Look sheet to the current look. */
export function syncLook() {
  const s = SF && lookOpen() ? SF : null;
  if (!s) return;
  for (const b of $$('[data-theme-set]', s)) b.setAttribute('aria-pressed', String(b.dataset.themeSet === L.theme));
  for (const i of $$('.tc-sw', s)) i.dataset.mode = resolveMode();
  for (const b of $$('[data-mode-set]', s)) b.setAttribute('aria-pressed', String(b.dataset.modeSet === L.mode));
  const h = Math.round((((L.hue != null ? L.hue : themeHue()) % 360) + 360) % 360);
  $<HTMLInputElement>('#lk-range', s).value = String(h);
  $('#lk-hue', s).textContent = h + '°';
  for (const b of $$('.hue-sw', s)) b.setAttribute('aria-pressed', String(L.hue != null && +b.dataset.hue! === h));
  $('#lk-reset', s).setAttribute('aria-disabled', String(L.hue == null));
  $('#lk-note', s).textContent = L.mode === 'system' ? `System follows your device. Now: ${mqDark.matches ? 'dark' : 'light'}.` : '';
}

export function openLook() {
  const b = $('#look-btn').getBoundingClientRect();
  const cur = () => {
    const bb = $('#look-btn').getBoundingClientRect();
    return boxOf(bb, bb.height / 2);
  };
  panel('sheet', lookHTML(), {
    w: 440,
    at: 'right',
    clear: true,
    from: boxOf(b, b.height / 2),
    fromFn: cur,
    after: (s) => {
      s.addEventListener('click', (e) => {
        const t = (e.target as Element).closest<HTMLElement>('[data-theme-set],[data-mode-set],[data-hue],#lk-reset');
        if (!t) return;
        if (t.dataset.themeSet) setLook({ theme: t.dataset.themeSet as typeof L.theme });
        else if (t.dataset.modeSet) setLook({ mode: t.dataset.modeSet as typeof L.mode });
        else if (t.dataset.hue) setLook({ hue: +t.dataset.hue });
        else if (L.hue != null) setLook({ hue: null });
      });
      const rg = $<HTMLInputElement>('#lk-range', s);
      rg.addEventListener('input', () => setLook({ hue: +rg.value }, { how: 'live' }));
      rg.addEventListener('change', () => root.classList.remove('hue-live'));
      syncLook();
    },
  });
}

/** For tests and screenshots: open a surface at once, with its pour finished. */
export function openNow(what: string) {
  if (what === 'look') openLook();
  else if (what === 'menu') {
    const first = S.order.find((id) => S.widgets.get(id)?.spec.kind === 'display');
    if (first) openMenu(first);
  } else if (what === 'folder') {
    const f = S.order.find((id) => S.widgets.get(id)?.spec.kind === 'folder');
    if (f) openFolder(f);
  }
}
