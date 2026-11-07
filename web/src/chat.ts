/**
 * The chat panel: a right glass panel on desktop, a pill that pours into a sheet on a phone. The agent behind it
 * (POST /api/chat, guarded replies, proposals to accept, set_look chips) is the next build: until then the panel
 * says so and sends nothing.
 */
import { $, clamp, mk } from './dom.ts';
import { S } from './board.ts';
import { closeSurface, surfaceOpen } from './surfaces.ts';

let chat: HTMLElement;
let scrim: HTMLElement;
let input: HTMLInputElement;
let scrimChat = false;

export function initChat() {
  chat = $('#chat');
  scrim = $('#scrim');
  input = $<HTMLInputElement>('#chat-input');
  const log = $('#chat-log');
  log.appendChild(mk('div', 'msg', 'Hi. Soon you can tell me your teams and markets here, and I&rsquo;ll build your board.'));
  log.appendChild(mk('div', 'msg msg--note', '<b>Next build.</b> The chat with your agent is not connected yet. Your board, its prices and the Look are live.'));
  input.disabled = true;
  input.placeholder = 'Chat arrives in the next build';
  $<HTMLButtonElement>('#chat-send').disabled = true;
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (S.phone && !chat.classList.contains('is-open')) openChat();
  });
  chat.addEventListener('click', (e) => {
    if (S.phone && !chat.classList.contains('is-open') && !(e.target as Element).closest('#chat-close')) openChat();
  });
  $('#chat-close').addEventListener('click', closeChat);
  $('.chat-handle').addEventListener('click', closeChat);
}

export function openChat() {
  if (!S.phone) return;
  chat.style.setProperty('--chat-h', clamp(innerHeight - 100, 340, 600) + 'px');
  if (surfaceOpen()) closeSurface(true);
  chat.classList.add('is-open');
  scrim.className = 'scrim on';
  scrimChat = true;
}

export function closeChat() {
  if (!chat?.classList.contains('is-open')) return;
  chat.classList.remove('is-open');
  if (scrimChat) scrim.classList.remove('on');
  scrimChat = false;
  input.blur();
}
