/**
 * What the ⋯ menu's rows do, through edge's menu endpoints. Refresh, Size and Move to a folder are sent at once;
 * Remove and Clear all show at once and are sent when their Undo offer ends (undo.ts), so Undo needs no endpoint.
 */
import { ApiError, api } from './api.ts';
import { $, mk } from './dom.ts';
import { S, hideTile, placesWithout, reconcile, saveLayout, shimmer, upsert } from './board.ts';
import { closeSurface, toast } from './surfaces.ts';
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

const title = (id: string) => S.widgets.get(id)?.spec.title ?? 'This widget';

export function menuAction(id: string, act: MenuAction, arg?: string) {
  const w = S.widgets.get(id);
  if (!w) return;
  if (act === 'agent' || act === 'how') return; // W1.3 and W1.2 wire these
  closeSurface();
  if (act === 'refresh') {
    shimmerOnce(id);
    api.refresh(id).catch((e: unknown) => {
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

