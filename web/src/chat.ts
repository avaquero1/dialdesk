/**
 * The chat with the agent (design.md section 7): a glass panel on the right on desktop, a pill at the bottom on a
 * phone that pours open into a sheet. A message goes to edge (POST /api/chat); the reply arrives whole after the
 * safety check, and a calm shimmer shows while the agent works. The conversation id is kept per account in this
 * browser, so the history reloads with the board (GET /api/chat/:id).
 *
 * The first visit sends the opener unseen, so the agent's greeting comes first, with its picks (leagues, then teams)
 * to tap. A tap sends the pick's text. The agent's words are shown as they come, always escaped.
 * A proposal is a question with two buttons, "Add 'Chiefs at Bills news'?" [Add] [Not now]: nothing changes without the
 * tap. Add accepts it through edge and the widgets pour in on the board; Not now rejects it. A look change (set_look)
 * applies live as the reply arrives, is saved through edge, and offers [Undo], which puts back the theme, mode and hue
 * from before it. "Change it with the agent" (the ⋯ menu) opens the chat with the widget named in the input.
 *
 * Motion: only transform and opacity. The phone sheet's glass grows from the pill's height by scaleY while the pill's
 * glass fades; the words rise after the shape. Nothing moves inside the glass at rest.
 */
import type { Account, Look } from '@app/contracts';
import { $, clamp, esc, mk, reduced } from './dom.ts';
import { ApiError, api } from './api.ts';
import { S } from './board.ts';
import {
  OPENER,
  chipView,
  currentPicks,
  decide,
  emptyChat,
  fail,
  fromHistory,
  lookChange,
  receive,
  send,
  undoLook,
  type ChatState,
  type ChipView,
  type Line,
  type Turn,
} from './chat-state.ts';
import { L, setLook } from './look.ts';
import { closeSurface, surfaceOpen } from './surfaces.ts';

const PILL_H = 58;

let chat: HTMLElement;
let scrim: HTMLElement;
let log: HTMLElement;
let quick: HTMLElement;
let input: HTMLInputElement;
let fab: HTMLButtonElement;
let scrimChat = false;
let st: ChatState = emptyChat();
let key = '';
let relayout: () => void = () => {};
let boardChanged: () => void = () => {};
let pendingAtLoad: ReadonlySet<string> | undefined;
/** The look from before the change [Undo] can take back now. */
let lookBefore: Look | null = null;
const shown = new Map<string, HTMLElement>();
const drawn = new Map<string, string>();

const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    /* no storage: the chat still works, it just won't reload */
  }
};
const recalled = () => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export interface ChatHooks {
  relayout: () => void;
  /** The proposals the board holds as pending at load: older proposal chips show without buttons. */
  pending: readonly string[];
  /** A proposal was accepted: fetch the board, so the widgets pour in. */
  boardChanged: () => void;
}

export function initChat(a: Account, o: ChatHooks) {
  chat = $('#chat');
  scrim = $('#scrim');
  log = $('#chat-log');
  quick = $('#chat-quick');
  input = $<HTMLInputElement>('#chat-input');
  key = `chat:${a.account_id}`;
  relayout = o.relayout;
  boardChanged = o.boardChanged;
  pendingAtLoad = new Set(o.pending);
  // The phone's two glass layers (the pill and the sheet), behind the words.
  chat.prepend(mk('i', 'chat-glass chat-glass--sheet'), mk('i', 'chat-glass chat-glass--pill'));
  fab = mk('button', 'chat-fab', '<i class="agent-bead"></i><span>Ask your agent…</span>');
  fab.type = 'button';
  fab.id = 'chat-fab';
  fab.setAttribute('aria-label', 'Open the chat with your agent');
  document.body.appendChild(fab);
  fab.addEventListener('click', () => showPanel(true));

  input.disabled = false;
  input.maxLength = 2000;
  input.placeholder = 'Ask your agent…';
  $<HTMLButtonElement>('#chat-send').disabled = false;
  $('#chat-close').addEventListener('click', () => (S.phone ? closeChat() : showPanel(false)));
  $('.chat-handle').addEventListener('click', closeChat);
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (S.phone && !chat.classList.contains('is-open')) return openChat();
    void submit(input.value);
  });
  chat.addEventListener('click', (e) => {
    if (S.phone && !chat.classList.contains('is-open') && (e.target as Element).closest('.chat-form')) openChat();
  });
  quick.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-pick]');
    if (b) void submit(b.dataset.pick!);
  });
  log.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-chip]');
    if (!b || b.disabled) return;
    if (b.dataset.chip === 'undo') return undoLookChange();
    void answer(b.dataset.pid!, b.dataset.chip === 'add');
  });
  void load();
}

/** The history, or the first visit's greeting. */
async function load() {
  const id = recalled();
  if (id) {
    try {
      const c = await api.conversation(id);
      st = fromHistory(c.conversation_id, c.turns as Turn[], pendingAtLoad);
      render();
      return;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) {
        st = { ...fail(st, e instanceof ApiError ? e : { status: -1 }), conversationId: id };
        return render();
      }
      remember(null); // gone (the agent restarted): start again
    }
  }
  await turn(OPENER, false);
}

async function submit(raw: string) {
  const text = raw.trim();
  if (!text || st.pending) return;
  input.value = '';
  await turn(text, true);
}

async function turn(text: string, visible: boolean) {
  st = send(st, text, visible);
  render();
  try {
    const r = await api.chat(st.conversationId, text);
    st = receive(st, r.conversation_id, r.turn as Turn);
    remember(r.conversation_id);
    const look = lookChange(r.turn as Turn);
    if (look) {
      lookBefore = { theme: L.theme, mode: L.mode, hue: L.hue };
      setLook(look); // live, and saved through edge
    }
  } catch (e) {
    const err = e instanceof ApiError ? e : { status: -1 };
    if (err instanceof ApiError && err.code === 'bad_conversation') {
      remember(null);
      st = { ...st, conversationId: null };
    }
    st = fail(st, err);
    if (visible && !input.value) input.value = text; // the words come back, to try again
  }
  render();
}

/** [Add] or [Not now] on a proposal: the call goes to edge; only then does the board change. */
async function answer(proposalId: string, add: boolean) {
  const d = st.decided[proposalId];
  if (d === 'busy' || d === 'accepted' || d === 'rejected' || d === 'gone') return;
  st = decide(st, proposalId, 'busy');
  render();
  try {
    await (add ? api.accept(proposalId) : api.reject(proposalId));
    st = decide(st, proposalId, add ? 'accepted' : 'rejected');
    if (add) boardChanged();
  } catch (e) {
    // 409: decided already (another tab); 404: no longer there. Either way the buttons go.
    const gone = e instanceof ApiError && (e.status === 409 || e.status === 404);
    st = decide(st, proposalId, gone ? 'gone' : 'failed');
    if (gone && add) boardChanged();
  }
  render();
}

/** [Undo] on a look change: the theme, mode and hue from before it, saved through edge. */
function undoLookChange() {
  if (!lookBefore || !st.undoLine) return;
  setLook(lookBefore);
  lookBefore = null;
  st = undoLook(st);
  render();
}

function chipHtml(v: ChipView): string {
  switch (v.kind) {
    case 'ask': {
      const off = v.busy ? ' disabled' : '';
      const pid = esc(v.proposalId);
      return (
        `<div class="chip-ask${v.busy ? ' is-busy' : ''}"><span class="chip-q">${esc(v.ask)}</span>` +
        `<span class="chip-btns"><button type="button" class="btn btn--sm btn--accent" data-chip="add" data-pid="${pid}"${off}>${esc(v.yes)}</button>` +
        `<button type="button" class="btn btn--sm" data-chip="skip" data-pid="${pid}"${off}>Not now</button></span>` +
        (v.failed ? `<span class="chip-note">That didn't go through. Try again in a moment.</span>` : '') +
        `</div>`
      );
    }
    case 'said':
      return `<span class="chip-said">${esc(v.text)}</span>`;
    case 'look':
      return (
        `<span class="tool-chip tool-chip--applied"><i></i><b>${esc(v.text)}</b></span>` +
        (v.undo ? `<button type="button" class="btn btn--sm chip-undo" data-chip="undo">Undo</button>` : '')
      );
    case 'label':
      return `<span class="tool-chip tool-chip--${esc(v.status)}"><i></i><b>${esc(v.label)}</b></span>`;
  }
}

function lineHtml(l: Line): string {
  if (l.role !== 'agent' || !l.chips.length) return esc(l.text);
  return `${esc(l.text)}<div class="msg-row">${l.chips.map((c) => chipHtml(chipView(st, l, c))).join('')}</div>`;
}

function render() {
  const keep = new Set(st.lines.map((l) => l.id));
  for (const [id, el] of shown) {
    if (!keep.has(id)) {
      el.remove();
      shown.delete(id);
      drawn.delete(id);
    }
  }
  let work = log.querySelector('.msg--working');
  if (work && !st.pending) {
    work.remove();
    work = null;
  }
  for (const l of st.lines) {
    const html = lineHtml(l);
    const had = shown.get(l.id);
    if (had) {
      // A chip was answered (or its Undo went): redraw that line's row in place; the answer fades in.
      if (drawn.get(l.id) !== html) {
        had.innerHTML = html;
        had.querySelector('.msg-row')?.classList.add('is-new');
        drawn.set(l.id, html);
      }
      continue;
    }
    const el = mk('div', `msg${l.role === 'user' ? ' msg--me' : l.role === 'error' ? ' msg--error' : ''} is-new`, html);
    el.dataset.role = l.role;
    shown.set(l.id, el);
    drawn.set(l.id, html);
    log.insertBefore(el, work);
  }
  if (st.pending && !work) {
    log.appendChild(
      mk('div', 'msg msg--working is-new', '<i class="chat-shim"></i><i class="chat-bar"></i><i class="chat-bar chat-bar--short"></i><span class="sr">Your agent is working on it.</span>'),
    );
  }
  const picks = currentPicks(st);
  quick.innerHTML = picks.map((p) => `<button type="button" class="chat-pick is-new" data-pick="${esc(p)}">${esc(p)}</button>`).join('');
  quick.classList.toggle('has-picks', picks.length > 0);
  chat.classList.toggle('is-working', !!st.pending);
  log.scrollTo({ top: log.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' });
}

/** Desktop: hide the panel (the board takes the room) or show it again. */
function showPanel(on: boolean) {
  if (S.phone) return;
  const board = document.querySelector<HTMLElement>('#board');
  const from = board?.getBoundingClientRect().left ?? 0;
  document.documentElement.classList.toggle('chat-hidden', !on);
  relayout();
  // The board re-centres at once; a transform glide from where it was, so the panel closing never snaps it.
  const shift = board ? from - board.getBoundingClientRect().left : 0;
  if (board && shift && !reduced()) board.animate([{ transform: `translateX(${shift}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.16,.84,.3,1)' });
  if (on) input.focus({ preventScroll: true });
  else fab.focus({ preventScroll: true });
}

export function openChat() {
  if (!S.phone) return showPanel(true);
  const h = clamp(innerHeight - 100, 340, 600);
  chat.style.setProperty('--chat-h', h + 'px');
  chat.style.setProperty('--pill-s', (PILL_H / h).toFixed(4));
  if (surfaceOpen()) closeSurface(true);
  chat.classList.add('is-open');
  scrim.className = 'scrim on';
  scrimChat = true;
  log.scrollTop = log.scrollHeight;
}

/** The phone's sheet drains back into the pill (the scrim and Escape call this; the desktop panel stays). */
export function closeChat() {
  if (!chat?.classList.contains('is-open')) return;
  chat.classList.remove('is-open');
  if (scrimChat) scrim.classList.remove('on');
  scrimChat = false;
  input.blur();
}

/**
 * "Change it with the agent" from a widget's ⋯ menu: the chat opens with the widget named in the input and the caret
 * at the end, for the user to finish the sentence.
 */
export function askAbout(title: string) {
  if (S.phone) openChat();
  else showPanel(true);
  input.value = `Change '${title}' to `;
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}
