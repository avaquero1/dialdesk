/**
 * What the ⋯ menu's rows do, through edge's menu endpoints. Refresh, Size and Move to a folder are sent at once;
 * Remove and Clear all show at once and are sent when their Undo offer ends (undo.ts), so Undo needs no endpoint.
 */
import { ApiError, api, noticeFor } from './api.ts';
import { $, mk } from './dom.ts';
import { S, adoptFolder, bindFolders, desktopPlaces, dropLocal, hideTile, isDragging, placesOf, placesWithout, reconcile, refreshTile, saveLayout, settleLocal, shimmer, showLocal, upsert, type LocalChange } from './board.ts';
import { adoptFolderSheet, closeSurface, syncFolder, toast } from './surfaces.ts';
import { openHow } from './safety.ts';
import { justNow, tileName } from './widgets.ts';
import { Undo, type UndoView } from './undo.ts';
import type { MenuAction, Size } from './menu.ts';
import type { Widget } from '@app/contracts';

let undo: Undo;
const shimT = new Map<string, number>();

/** The Undo toast: the glass of the plain toast, with one button. */
function undoView(): UndoView {
  const el = mk('div', 'undo-toast', '<span class="u-text"></span><button class="u-btn" type="button">Undo</button>');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  $('#toast').after(el);
  el.querySelector('button')!.addEventListener('click', () => undo.undo());
  return {
    show: (text) => {
      $('#toast').classList.remove('on');
      el.querySelector('.u-text')!.textContent = text;
      el.classList.add('on');
    },
    hide: () => el.classList.remove('on'),
  };
}

export function initActions() {
  undo = new Undo(undoView(), undefined, undefined, (_c, e) => {
    if (e instanceof Said) return;
    if (!(e instanceof ApiError) || ![401, 429, 413].includes(e.status)) toast('Couldn’t save that change. It’s back as it was.');
  });
  bindFolders({ drop, takeOut, rename, saveOrder });
  // Leaving the page, or a phone putting it away: what waits for its Undo offer is sent now.
  addEventListener('pagehide', () => void undo.send(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void undo.send(true);
  });
}

/** The liquid shimmer runs once per refresh: restart it, then take the class off so the next one runs too. */
function shimmerOnce(id: string) {
  shimmer(id, false);
  requestAnimationFrame(() => shimmer(id, true));
  clearTimeout(shimT.get(id));
  shimT.set(id, window.setTimeout(() => shimmer(id, false), 1900));
}

const title = (id: string) => {
  const w = S.widgets.get(id);
  return w ? tileName(w) : 'This widget';
};

export function menuAction(id: string, act: MenuAction, arg?: string) {
  if (!S.local.length) return runMenu(id, act, arg);
  // A folder change is waiting: it goes first, and this row may name a folder that only now gets its id.
  closeSurface();
  void undo.send(false);
  void inOrder(() => Promise.resolve()).then(() => runMenu(realIds.get(id) ?? id, act, arg && (realIds.get(arg) ?? arg)));
}

function runMenu(id: string, act: MenuAction, arg?: string) {
  const w = S.widgets.get(id);
  if (!w) return;
  if (act === 'agent') return; // W1.3 wires this
  closeSurface();
  if (act === 'how') return void openHow(id);
  if (act === 'refresh') {
    shimmerOnce(id);
    api
      .refresh(id)
      .then((r) => {
        // It joined the run already asked for this minute: the numbers on screen are that run's, so say so.
        if (r.joined) {
          justNow.set(id, Date.now());
          refreshTile(id);
          toast(`${title(id)}: updated just now.`);
        }
      })
      .catch((e: unknown) => {
        // The call is quiet, so this is the one line: one widget refreshed often this hour, or else the account's cap
        // on refreshes (or edge's limit), which gets design.md's plain "too fast".
        if (e instanceof ApiError && e.status === 429 && e.code === 'too_many_refreshes') toast(`${title(id)} was refreshed often this hour. Try again later.`);
        else if (e instanceof ApiError && e.status === 429) toast(noticeFor(e)!);
        else if (!(e instanceof ApiError) || e.status !== 401) toast('Couldn’t refresh it.');
      });
  } else if (act === 'size' && arg) {
    api
      .resize(id, arg as Size)
      .then((nw) => {
        upsert(nw);
        saveLayout();
      })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError) || ![401, 429, 413].includes(e.status)) toast('Couldn’t change the size.');
      });
  } else if (act === 'move' && arg) {
    const folder = S.widgets.get(arg);
    const index = S.kids.get(arg)?.length ?? 0;
    const places = [...placesWithout(id), { widget_id: id, place: { folder_id: arg, index } }];
    api
      .setLayout(places)
      .then((b) => {
        reconcile(b.widgets);
        toast(`Moved to ${folder?.spec.title ?? 'the folder'}.`);
      })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError) || ![401, 429, 413].includes(e.status)) toast('Couldn’t move it.');
      });
  } else if (act === 'clear') {
    undo.offer({
      text: `${title(id)} is back to its defaults.`,
      apply: () => {},
      revert: () => {},
      commit: ({ keepalive }) =>
        api.clear(id, { keepalive }).then((nw) => {
          if (keepalive) return;
          upsert(nw);
          shimmerOnce(id);
        }),
    });
  } else if (act === 'remove') {
    undo.offer({
      text: `Removed ${title(id)}.`,
      apply: () => hideTile(id, true),
      revert: () => hideTile(id, false),
      commit: ({ keepalive }) =>
        api
          .remove(id, { keepalive })
          .catch((e: unknown) => {
            if (!(e instanceof ApiError) || e.status !== 404) throw e; // already gone: that's the goal
          })
          .then(async () => {
            if (keepalive) return;
            const b = await api.board().catch(() => null);
            S.hidden.delete(id);
            if (b) reconcile(b.widgets);
          }),
    });
  }
}


/** A folder's cards are refreshed at most this often when it opens (each card may refresh 12 times an hour). */
const FOLDER_REFRESH_MS = 10 * 60_000;
const folderRefreshed = new Map<string, number>();

/**
 * Opening a folder refreshes its cards: each one asks for a numbers run, which joins one already asked for this
 * minute, so it costs little. Quietly: a card that can't refresh keeps its numbers.
 */
export function refreshFolder(id: string, now = Date.now()) {
  if (now - (folderRefreshed.get(id) ?? 0) < FOLDER_REFRESH_MS) return;
  folderRefreshed.set(id, now);
  for (const k of S.kids.get(id) ?? []) if (S.widgets.get(k)?.spec.kind === 'display') api.refresh(k).catch(() => {});
}


// ---------- folders: drag and drop, deferred behind Undo like Remove and Clear all ----------

/** A failure that has already said its own words (or follows one that did). */
class Said extends Error {}

/** A made folder's temporary id, until POST /api/folders answers with the real one. */
const TEMP = 'tmp_';
let tempN = 0;
const realIds = new Map<string, string>();

/** A change's call runs after the one before it: a later change may name a folder the earlier one makes. */
let chain: Promise<unknown> = Promise.resolve();
function inOrder<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

const need = (id: string) => {
  if (!id.startsWith(TEMP)) return id;
  const real = realIds.get(id);
  if (!real) throw new Said();
  return real;
};

/** The change whose Undo offer is open, if it is a folder change. */
let waiting: LocalChange | null = null;

/** Show a folder change now, offer Undo; `send` runs in order when the offer ends. */
function offerFolder(text: string, c: LocalChange, send: (o: { keepalive: boolean }) => Promise<void>) {
  undo.offer({
    text,
    apply: () => {
      showLocal(c);
      syncFolder();
      waiting = c;
    },
    revert: () => {
      if (waiting === c) waiting = null;
      dropLocal(c);
      syncFolder();
    },
    commit: (o) => {
      if (waiting === c) waiting = null;
      return inOrder(() => send(o)).then(() => syncFolder());
    },
  });
}

const mentions = (c: LocalChange, id: string) =>
  c.gone === id || c.title?.id === id || [...c.places].some(([w, p]) => w === id || ('folder_id' in p && p.folder_id === id));

/** A card dropped on a card or on a folder. */
function drop(card: string, target: string) {
  const t = S.widgets.get(target);
  if (!t) return;
  if (t.spec.kind === 'folder') addToFolder(card, target);
  else if ('col' in t.spec.place) makeFolder(target, card, t.spec.place);
}

function makeFolder(target: string, card: string, place: { col: number; row: number }) {
  const tmp = TEMP + ++tempN;
  const b = S.widgets.get(target)!;
  const folder: Widget = {
    spec: { widget_id: tmp, account_id: b.spec.account_id, kind: 'folder', title: 'Folder', children: [], place },
    profile: null,
    state: 'normal',
    result: null,
    previous: null,
    updated_at: new Date().toISOString(),
  };
  const c: LocalChange = {
    folder,
    places: new Map([
      [target, { folder_id: tmp, index: 0 }],
      [card, { folder_id: tmp, index: 1 }],
    ]),
  };
  offerFolder('Made a folder.', c, async ({ keepalive }) => {
    S.sending++;
    let widgets: Widget[];
    try {
      ({ widgets } = await api.makeFolder([target, card], place, { keepalive }));
    } catch (e) {
      // What waits behind this change named its folder: it can't happen either.
      if (waiting && mentions(waiting, tmp)) undo.undo();
      if (e instanceof ApiError && e.status === 409) {
        toast('Your board is full. Remove something to make a folder.');
        throw new Said();
      }
      throw e;
    } finally {
      S.sending--;
    }
    const made = widgets.find((w) => w.spec.kind === 'folder' && w.spec.children.includes(target));
    if (made) {
      realIds.set(tmp, made.spec.widget_id);
      adoptFolder(tmp, made.spec.widget_id);
      adoptFolderSheet(tmp, made.spec.widget_id);
    }
    settleLocal(c, widgets);
  });
}

function addToFolder(card: string, folder: string) {
  const name = S.widgets.get(folder)!.spec.title;
  const c: LocalChange = { places: new Map([[card, { folder_id: folder, index: S.kids.get(folder)?.length ?? 0 }]]) };
  offerFolder(`Moved to ${name}.`, c, async ({ keepalive }) => {
    const p = c.places.get(card) as { folder_id: string; index: number };
    const b = await api.setLayout([{ widget_id: card, place: { folder_id: need(p.folder_id), index: p.index } }], { keepalive });
    settleLocal(c, b.widgets);
  });
}

/** A card out of a folder, onto the grid at this index. The folder goes when its last card leaves. */
function takeOut(card: string, folder: string, index: number) {
  const gone = (S.kids.get(folder) ?? []).filter((k) => k !== card).length === 0;
  const order = [...S.order];
  order.splice(index, 0, card);
  const c: LocalChange = { places: new Map(placesOf(gone ? order.filter((id) => id !== folder) : order).map((p) => [p.widget_id, p.place])), ...(gone && { gone: folder }) };
  offerFolder('Back on the board.', c, async ({ keepalive }) => {
    const places = [...c.places].map(([id, place]) => ({ widget_id: need(id), place }));
    const put = api.setLayout(places, { keepalive });
    const empty = c.gone && need(c.gone);
    // Page going away: both now (a folder removed first puts its card on the grid, and the layout then places it).
    const del = () => (empty ? api.remove(empty, { keepalive }).catch((e: unknown) => {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }) : Promise.resolve({ ok: true as const }));
    if (keepalive) {
      void del().catch(() => {});
      await put;
      return;
    }
    const b = await put;
    await del();
    settleLocal(c, c.gone ? (await api.board()).widgets : b.widgets);
  });
}

function rename(folder: string, title: string) {
  const c: LocalChange = { places: new Map(), title: { id: folder, title } };
  offerFolder(`Renamed to ${title}.`, c, async ({ keepalive }) => {
    const res = await api.setTitle(need(c.title!.id), title, { keepalive }).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 400) {
        toast('That name can’t be used. Try letters and numbers.');
        throw new Said();
      }
      throw e;
    });
    settleLocal(c, S.last.map((w) => (w.spec.widget_id === res.spec.widget_id ? res : w)));
  });
}

/** A drag's order while a folder change waits: after that change, with the ids it got. */
function saveOrder(order: string[]) {
  void undo.send(false);
  void inOrder(async () => {
    const ids = order.map((id) => realIds.get(id) ?? id).filter((id) => S.widgets.has(id));
    const b = await api.setLayout(desktopPlaces(ids));
    if (!isDragging()) reconcile(b.widgets);
  }).catch((e: unknown) => {
    if (!(e instanceof ApiError) || ![401, 429, 413].includes(e.status)) toast('Couldn’t save the layout.');
    void api.board().then((b) => reconcile(b.widgets)).catch(() => {});
  });
}
