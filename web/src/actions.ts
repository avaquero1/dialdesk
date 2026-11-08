/**
 * What the ⋯ menu's rows do, through edge's menu endpoints. Refresh, Size and Move to a folder are sent at once;
 * Remove and Clear all show at once and are sent when their Undo offer ends (undo.ts), so Undo needs no endpoint.
 */
import { ApiError, api } from './api.ts';
import { $, mk } from './dom.ts';
import { S, hideTile, placesWithout, reconcile, refreshTile, saveLayout, shimmer, upsert } from './board.ts';
import { closeSurface, toast } from './surfaces.ts';
import { openHow } from './safety.ts';
import { justNow, tileName } from './widgets.ts';
import { Undo, type UndoView } from './undo.ts';
import type { MenuAction, Size } from './menu.ts';

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
    if (!(e instanceof ApiError) || ![401, 429, 413].includes(e.status)) toast('Couldn’t save that change. It’s back as it was.');
  });
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
        if (e instanceof ApiError && e.status === 429) toast(`${title(id)} was refreshed often this hour. Try again later.`);
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
