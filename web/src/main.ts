/**
 * Boot: is there a session? If not, the door (sign up, log in, guest). If so, the account's look, its board from
 * board (first paint from the quotes board copied from markets), and /live for what changes.
 */
import type { Account, EventName, Look } from '@app/contracts';
import { $, finishAnimations, raf2, root, wait } from './dom.ts';
import { ApiError, api, setApiHooks } from './api.ts';
import { showAuth } from './auth.ts';
import { EL, S, bindBoard, buildLens, desktopPlaces, isDragging, layoutAll, mount, reconcile, shimmer, updateRefraction } from './board.ts';
import { closeChat, initChat } from './chat.ts';
import { fillIcons } from './icons.ts';
import { Live } from './live.ts';
import { initLook, lookFromServer } from './look.ts';
import { closeSurface, initSurfaces, openApp, openFolder, openMenu, openNow, syncLook, toast } from './surfaces.ts';

declare global {
  interface Window {
    /** True once the board has painted and its entrance is done (tests and screenshots wait for it). */
    __ready?: boolean;
  }
}

const Q = new URLSearchParams(location.search);
let account: Account | null = null;
let live: Live | null = null;
let noticeT = 0;

function notice(text: string) {
  const n = $('#notice');
  n.textContent = text;
  n.classList.add('on');
  clearTimeout(noticeT);
  noticeT = window.setTimeout(() => n.classList.remove('on'), 5000);
}

function setMotion() {
  let pref: { motion?: string; refract?: string } = {};
  try {
    pref = JSON.parse(localStorage.getItem('prefs') ?? '{}') as typeof pref;
  } catch {
    /* no stored preference */
  }
  const sys = matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.dataset.motion = sys || pref.motion === 'reduced' || Q.get('motion') === 'reduced' ? 'reduced' : 'full';
  const canRefract = /Chrome\//.test(navigator.userAgent) && CSS.supports('backdrop-filter', 'url(#a) blur(1px)');
  root.dataset.refract = canRefract && pref.refract !== '0' && Q.get('refract') !== '0' ? '1' : '0';
}

/** The session ended (a 401, or /live closed with 4001 and /api/me agrees): back to the door. */
function sessionLost() {
  live?.stop();
  live = null;
  location.reload();
}

// ---------- the board's data ----------

let refetchT = 0;
let refetching = false;
function refetchSoon(ms = 250) {
  clearTimeout(refetchT);
  refetchT = window.setTimeout(refetch, ms);
}
async function refetch() {
  if (refetching) return refetchSoon(400);
  if (isDragging()) return refetchSoon(600);
  refetching = true;
  try {
    reconcile((await api.board()).widgets);
  } catch {
    /* a notice is already shown for 429 and offline; a 401 goes to the door */
  } finally {
    refetching = false;
  }
}

let saving: Promise<unknown> = Promise.resolve();
function saveOrder(order: string[]) {
  const places = desktopPlaces(order);
  saving = saving
    .then(() => api.setLayout(places))
    .then((b) => {
      if (!isDragging()) reconcile(b.widgets);
    })
    .catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 429 || e.status === 413 || e.status === 401)) return;
      toast('Couldn’t save the layout. Showing the saved board.');
      refetchSoon(0);
    });
}

function onEvent(event: EventName, p: Record<string, unknown>) {
  const wid = typeof p.widget_id === 'string' ? p.widget_id : null;
  switch (event) {
    case 'look.changed':
      if (p.look && typeof p.look === 'object') lookFromServer(p.look as Look);
      break;
    case 'run.started':
      if (wid) shimmer(wid, true);
      break;
    case 'run.failed':
    case 'run.poisoned':
      if (wid) shimmer(wid, false);
      refetchSoon();
      break;
    case 'widget.updated':
    case 'result.updated':
    case 'movement.flagged':
      refetchSoon();
      break;
    default:
      break; // run.step feeds the run trace (next build)
  }
}

async function start(a: Account) {
  window.__ready = false;
  account = a;
  root.dataset.view = 'board';
  initLook(
    {
      onThemeChanged: () => {
        updateRefraction();
        layoutAll();
      },
      onModeChanged: buildLens,
      onSynced: syncLook,
      save: (look) =>
        api.setLook(look).catch((e: unknown) => {
          if (!(e instanceof ApiError) || e.status === 400) toast('Couldn’t save the look.');
          throw e;
        }),
    },
    a.look,
  );
  updateRefraction();
  const b = await api.board();
  mount(b.widgets);
  bindBoard({ openMenu, openApp, openFolder, saveOrder, closeSurface });
  initSurfaces({ account: () => account, logout, closeChat });
  initChat();
  live = new Live({
    onEvent,
    onReconnect: () => refetchSoon(0),
    onSessionEnded: () => {
      // 4001: the session ended or expired. Ask /api/me: a 401 there goes to the door; otherwise reconnect.
      api
        .me()
        .then((me) => {
          account = me;
          lookFromServer(me.look);
          live?.start();
          refetchSoon(0);
        })
        .catch(() => {});
    },
    onState: (s) => root.classList.toggle('is-offline', s === 'closed'),
  });
  live.start();
  await wait(root.dataset.motion === 'reduced' ? 300 : 2700);
  const o = Q.get('open');
  if (o) {
    finishAnimations();
    openNow(o);
    await wait(300);
    finishAnimations();
  }
  raf2(() => {
    window.__ready = true;
  });
}

async function logout() {
  try {
    await api.logout();
  } finally {
    sessionLost();
  }
}

async function boot() {
  window.__ready = false;
  setMotion();
  fillIcons();
  setApiHooks({ onSessionLost: sessionLost, onNotice: notice });
  let me: Account | null = null;
  try {
    me = await api.me({ auth: false });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) {
      // The server is down or busy: say so on the door.
      notice(e instanceof ApiError && e.status === 429 ? 'Too many requests. Wait a moment, then reload.' : 'The board is not reachable right now.');
    }
  }
  if (me) await start(me);
  else {
    showAuth((a) => void start(a));
    window.__ready = true;
  }
}

void boot();
export { EL, S };
