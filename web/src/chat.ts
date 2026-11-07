/**
 * The chat with the agent (design.md section 7): a glass panel on the right on desktop, a pill at the bottom on a
 * phone that pours open into a sheet. A message goes to edge (POST /api/chat); the reply arrives whole after the
 * safety check, and a calm shimmer shows while the agent works. The conversation id is kept per account in this
 * browser, so the history reloads with the board (GET /api/chat/:id).
 *
 * The first visit sends the opener unseen, so the agent's greeting comes first, with its picks (leagues, then teams)
 * to tap. A tap sends the pick's text. The agent's words are shown as they come, always escaped.
 * Not here yet (W1.3.2): [Add] [Not now] on proposals and applying the look from a chip.
 *
 * Motion: only transform and opacity. The phone sheet's glass grows from the pill's height by scaleY while the pill's
 * glass fades; the words rise after the shape. Nothing moves inside the glass at rest.
 */
import type { Account } from '@app/contracts';
import { $, clamp, esc, mk, reduced } from './dom.ts';
import { ApiError, api } from './api.ts';
import { S } from './board.ts';
import { OPENER, currentPicks, emptyChat, fail, fromHistory, receive, send, type ChatState, type Line, type Turn } from './chat-state.ts';
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
const shown = new Map<string, HTMLElement>();

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

export function initChat(a: Account, o: { relayout: () => void }) {
  chat = $('#chat');
  scrim = $('#scrim');
  log = $('#chat-log');
  quick = $('#chat-quick');
  input = $<HTMLInputElement>('#chat-input');
  key = `chat:${a.account_id}`;
  relayout = o.relayout;
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
  void load();
}

/** The history, or the first visit's greeting. */
async function load() {
  const id = recalled();
  if (id) {
    try {
      const c = await api.conversation(id);
      st = fromHistory(c.conversation_id, c.turns as Turn[]);
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

function lineHtml(l: Line): string {
  if (l.role !== 'agent' || !l.chips.length) return esc(l.text);
  const chips = l.chips.map((c) => `<span class="tool-chip tool-chip--${esc(c.status)}"><i></i><b>${esc(c.label)}</b></span>`).join('');
  return `${esc(l.text)}<div class="msg-row">${chips}</div>`;
}

function render() {
  const keep = new Set(st.lines.map((l) => l.id));
  for (const [id, el] of shown) {
    if (!keep.has(id)) {
      el.remove();
      shown.delete(id);
    }
  }
  let work = log.querySelector('.msg--working');
  if (work && !st.pending) {
    work.remove();
    work = null;
  }
  for (const l of st.lines) {
    if (shown.has(l.id)) continue;
    const el = mk('div', `msg${l.role === 'user' ? ' msg--me' : l.role === 'error' ? ' msg--error' : ''} is-new`, lineHtml(l));
    el.dataset.role = l.role;
    shown.set(l.id, el);
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
  document.documentElement.classList.toggle('chat-hidden', !on);
  relayout();
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
