/**
 * The Accounts app: connect Kalshi read only (a key id and a private key) or a Polymarket wallet (a public address).
 *
 * The private key is sealed in the page to connections' public key (connections' own seal.ts: WebCrypto X25519, HKDF,
 * AES-GCM, bound to this account and key id) and sent through edge's opaque connect route. The field is emptied the
 * moment it is read, whatever happens next; the key is never stored, logged or kept in a variable after the send.
 * connections proves read scope with Kalshi and refuses a key that can trade (403); the sheet says why in plain words.
 */
import type { Account, Connection, Widget } from '@app/contracts';
import { seal, sealAad } from '../../services/connections/src/seal.ts';
import { api, ApiError } from './api.ts';
import { connections, onConnections, setConnections } from './conns.ts';
import { $, esc } from './dom.ts';
import { S, refreshTile } from './board.ts';
import { IC } from './icons.ts';
import { panel, refill, rz, sheetHead, tileFrom, toast } from './surfaces.ts';
import { fmtTime, tileName } from './widgets.ts';

export const PROMISE = 'Read only. We can see your balance and positions. We can never trade or move money.';

/** Plain reasons for connections' refusals (its codes), in our words. */
const REFUSED: Record<string, string> = {
  write_scope: 'This key can trade, so we did not keep it. Make a new key with only "Read" allowed, then paste that one.',
  unknown_scope: 'Kalshi says this key can do more than read, so we did not keep it. Make a new key with only "Read" allowed.',
  scope_not_verified: 'Kalshi could not check this key right now. Nothing was saved. Try again in a minute.',
  key_not_found: 'Kalshi does not know this key id. Check that the key id and the private key are from the same key.',
  bad_key: 'That private key did not work. Copy the whole file again, from the first line to the last.',
};

let account: () => Account | null = () => null;

export const checkedLine = (c: Connection) =>
  c.exchange === 'kalshi'
    ? c.scope_verified && c.checked_at
      ? `Read only, checked with Kalshi at ${fmtTime(c.checked_at)}`
      : 'Read only. Kalshi has not confirmed it yet, so it stays off the public link.'
    : `Public wallet, read only${c.checked_at ? `. Added at ${fmtTime(c.checked_at)}` : ''}`;

export async function loadConnections() {
  try {
    setConnections((await api.connections()).connections);
  } catch {
    /* the list stays as it was; the sheet says when it can't load */
  }
}

/** At start: the list, and a tap on "Not connected" on the Your account display opens this app. */
export function initAccounts(h: { account: () => Account | null }) {
  account = h.account;
  // "Your account" shows the connection (or "Not connected"): redraw it when the list changes.
  onConnections(() => {
    for (const [id, w] of S.widgets) if (w.spec.kind === 'display' && w.spec.type === 'positions') refreshTile(id);
  });
  void loadConnections();
  $('#board').addEventListener('click', (e) => {
    const t = (e.target as Element).closest<HTMLElement>('[data-open-accounts]');
    if (!t) return;
    e.stopPropagation();
    openAccounts(t.closest<HTMLElement>('.w')?.dataset.id ?? accountsTile());
  });
}

const accountsTile = () => S.order.find((id) => { const w = S.widgets.get(id); return w?.spec.kind === 'app' && w.spec.app === 'accounts'; }) ?? '';

// ---------- the sheet ----------

/** Where to find a read-only Kalshi key, for someone who has never made one. Kalshi's own site only. */
const KALSHI_STEPS = [
  'On a computer, go to kalshi.com and log in.',
  'Open your account settings and find "API keys".',
  'Choose "Create key". Give it a name you will know, like "My board".',
  'Where it asks what the key may do, allow only "Read". Leave trading off.',
  'Kalshi shows a Key ID and saves a private key file. Copy the Key ID into the first box below.',
  'Open the private key file with a text editor (Notepad, TextEdit). Copy all of it, from -----BEGIN to the last line, into the second box.',
  'Tap Connect. We check with Kalshi that the key can only read. You can delete the file after.',
];

// ---------- "Your account": which display shows which account ----------

/** The board's "Your account" displays (positions), in board order. */
const yourAccountDisplays = (): Widget[] =>
  [...S.widgets.values()].filter((w) => w.spec.kind === 'display' && w.spec.type === 'positions');
const linkedTo = (w: Widget) => (w.spec.kind === 'display' ? w.spec.params.connection_id : undefined);

/** board links the account to the display (it checks both are this account's) and asks for its first numbers. */
async function link(widget_id: string, connection_id: string) {
  const w = await api.linkConnection(widget_id, connection_id);
  S.widgets.set(widget_id, w);
  refreshTile(widget_id);
}

/**
 * After the user shares an account's numbers: a board with one "Your account" display shows it there at once, unless
 * that display already shows another shared account. Otherwise the account's row offers each display (linkOffer).
 */
async function linkAfterShare(connection_id: string) {
  const ds = yourAccountDisplays();
  if (ds.length !== 1) return;
  const now = linkedTo(ds[0]!);
  if (now === connection_id) return;
  if (now && connections().some((c) => c.connection_id === now && c.share_numbers)) return;
  await link(ds[0]!.spec.widget_id, connection_id);
}

/** In a shared account's row: where it shows, and a button for each "Your account" display that shows something else. */
function linkOffer(c: Connection) {
  if (!c.share_numbers) return '';
  const ds = yourAccountDisplays();
  const on = ds.filter((w) => linkedTo(w) === c.connection_id);
  const off = ds.filter((w) => linkedTo(w) !== c.connection_id);
  const name = (w: Widget) => (ds.length > 1 ? `${tileName(w)} (${ds.indexOf(w) + 1})` : tileName(w));
  return (
    (on.length ? `<div class="s ac-shown">Shown on ${esc(on.map(name).join(', '))}.</div>` : '') +
    off
      .map((w) => `<button class="btn ac-link" type="button" data-link="${esc(w.spec.widget_id)}" data-link-conn="${esc(c.connection_id)}">Show on ${esc(name(w))}</button>`)
      .join('')
  );
}

function connRow(c: Connection, i: number) {
  const name = c.exchange === 'kalshi' ? `Kalshi · key ${c.label}` : `Polymarket · ${c.label}`;
  return (
    `<div class="ac-conn${rz(i)} data-conn="${esc(c.connection_id)}">` +
    `<div class="rowitem"><span class="ic ok">${IC.check}</span><div class="grow"><div class="t">${esc(name)}</div><div class="s">${esc(checkedLine(c))}</div></div>` +
    `<button class="btn ac-off" type="button" data-disconnect="${esc(c.connection_id)}">Disconnect</button></div>` +
    `<div class="rowitem ac-share"><div class="grow"><div class="t">Let my widgets use its numbers</div><div class="s">Balance and positions only. Turn it off any time.</div></div>` +
    `<button class="toggle" type="button" data-share="${esc(c.connection_id)}" aria-pressed="${c.share_numbers}" aria-label="Let my widgets use its numbers"></button></div>` +
    linkOffer(c) +
    '</div>'
  );
}

function bodyHTML(tab: 'kalshi' | 'polymarket') {
  let i = 1;
  const list = connections();
  const html = [
    sheetHead('Accounts'),
    `<p class="ac-promise${rz(i++)} id="ac-promise"><span class="ic">${IC.shield}</span><span>${esc(PROMISE)}</span></p>`,
  ];
  if (list.length) {
    html.push(`<h3 class="sf-h${rz(i++)}>Connected</h3>`);
    for (const c of list) html.push(connRow(c, i++));
  }
  html.push(
    `<div class="seg ac-tabs${rz(i++)} role="tablist" aria-label="Which exchange">` +
      `<button type="button" role="tab" data-tab="kalshi" aria-pressed="${tab === 'kalshi'}">Kalshi</button>` +
      `<button type="button" role="tab" data-tab="polymarket" aria-pressed="${tab === 'polymarket'}">Polymarket</button></div>`,
  );
  if (tab === 'kalshi')
    html.push(
      `<form class="auth-form ac-form${rz(i++)} id="ac-kalshi" autocomplete="off" novalidate>` +
        `<label><span>Key ID</span><input name="key_id" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="80" placeholder="Looks like a1b2c3d4-…"></label>` +
        `<label><span>Private key</span><textarea name="pem" rows="5" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></label>` +
        `<label class="ac-demo"><input name="demo" type="checkbox"><span>It is a Kalshi demo key (practice money)</span></label>` +
        `<p class="auth-err" id="ac-err" role="alert"></p>` +
        `<button class="btn btn--accent ac-go" type="submit">Connect Kalshi</button></form>` +
        `<details class="ac-help${rz(i)}><summary>How do I get a read-only key?</summary><ol>${KALSHI_STEPS.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` +
        `<p class="sf-note">Your private key is locked in this page before it is sent, and only our account reader can open it. We never show it again.</p></details>`,
    );
  else
    html.push(
      `<form class="auth-form ac-form${rz(i)} id="ac-poly" autocomplete="off" novalidate>` +
        `<label><span>Wallet address</span><input name="wallet" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="42" placeholder="0x…"></label>` +
        `<p class="sf-note">Only your public address, which anyone can look up. Never type your recovery words or a private key here.</p>` +
        `<p class="auth-err" id="ac-err" role="alert"></p>` +
        `<button class="btn btn--accent ac-go" type="submit">Connect Polymarket</button></form>`,
    );
  return html.join('');
}

const pemType = (pem: string): 'rsa' | 'ed25519' => {
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) return 'rsa';
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return body.length > 200 ? 'rsa' : 'ed25519';
};

function errorWords(e: unknown) {
  if (e instanceof ApiError) {
    if (REFUSED[e.code]) return REFUSED[e.code]!;
    if (e.status === 0) return "Can't reach the server. Nothing was sent. Try again.";
    if (e.status === 429) return 'Too many tries. Wait a minute, then try again.';
    if (e.status === 400 || e.status === 422) return 'That did not look right. Check both boxes and try again.';
  }
  return 'That did not work. Nothing was saved. Try again.';
}

async function connectKalshi(f: HTMLFormElement) {
  const keyIn = f.elements.namedItem('key_id') as HTMLInputElement;
  const pemIn = f.elements.namedItem('pem') as HTMLTextAreaElement;
  const key_id = keyIn.value.trim();
  const pem = pemIn.value.trim();
  // The key leaves the field at once: after this, it lives only in this function until it is sealed.
  pemIn.value = '';
  const a = account();
  if (key_id.length < 8) return 'Paste the Key ID from Kalshi into the first box.';
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) return 'Paste the whole private key, starting with -----BEGIN.';
  if (!a) return 'Your session ended. Log in again.';
  const key_type = pemType(pem);
  const { public_key } = await api.connectionsKey();
  const sealed_key = await seal(public_key, pem, sealAad(a.account_id, key_id));
  const env = (f.elements.namedItem('demo') as HTMLInputElement).checked ? 'demo' : 'prod';
  await api.connect({ exchange: 'kalshi', key_id, key_type, sealed_key, env });
  keyIn.value = '';
  return null;
}

async function connectPoly(f: HTMLFormElement) {
  const inp = f.elements.namedItem('wallet') as HTMLInputElement;
  const wallet = inp.value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return 'A wallet address starts with 0x and has 40 letters and numbers after it.';
  await api.connect({ exchange: 'polymarket', wallet });
  inp.value = '';
  return null;
}

function bind(s: HTMLElement, tab: 'kalshi' | 'polymarket') {
  const redraw = (t = tab) => {
    if (!s.isConnected) return;
    refill(bodyHTML(t));
    bind(s, t);
  };
  for (const b of s.querySelectorAll<HTMLElement>('[data-tab]')) b.onclick = () => redraw(b.dataset.tab as 'kalshi' | 'polymarket');
  for (const b of s.querySelectorAll<HTMLButtonElement>('[data-disconnect]'))
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api.disconnect(b.dataset.disconnect!);
        await loadConnections();
        toast('Disconnected. Its key is deleted.');
        redraw();
      } catch {
        b.disabled = false;
        toast('Couldn’t disconnect. Try again.');
      }
    };
  for (const b of s.querySelectorAll<HTMLButtonElement>('[data-share]'))
    b.onclick = async () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.disabled = true;
      try {
        await api.consent(b.dataset.share!, on);
        b.setAttribute('aria-pressed', String(on));
        await loadConnections();
        if (on) await linkAfterShare(b.dataset.share!).catch(() => toast('Shared. Couldn’t show it on Your account yet.'));
        return redraw();
      } catch {
        toast('Couldn’t save that. Try again.');
      }
      b.disabled = false;
    };
  for (const b of s.querySelectorAll<HTMLButtonElement>('[data-link]'))
    b.onclick = async () => {
      b.disabled = true;
      try {
        await link(b.dataset.link!, b.dataset.linkConn!);
        toast('It shows there now, read only.');
        return redraw();
      } catch {
        toast('Couldn’t show it there. Try again.');
      }
      b.disabled = false;
    };
  s.querySelector('.ac-help')?.addEventListener('toggle', () => refill());
  const f = s.querySelector<HTMLFormElement>('.ac-form');
  if (!f) return;
  const err = $('#ac-err', s);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const go = f.querySelector<HTMLButtonElement>('.ac-go')!;
    go.disabled = true;
    err.textContent = '';
    const label = go.textContent;
    go.textContent = 'Checking…';
    try {
      const msg = await (tab === 'kalshi' ? connectKalshi(f) : connectPoly(f));
      if (msg) err.textContent = msg;
      else {
        await loadConnections();
        toast(tab === 'kalshi' ? 'Kalshi connected, read only.' : 'Polymarket wallet connected.');
        return redraw();
      }
    } catch (x) {
      err.textContent = errorWords(x);
    }
    go.disabled = false;
    go.textContent = label;
  };
}

/** The Accounts sheet, poured from a tile (the Accounts app, or the Your account display). */
export function openAccounts(fromId: string) {
  if (!fromId) return;
  panel('sheet sheet--accounts', bodyHTML('kalshi'), {
    w: 520,
    from: tileFrom(fromId),
    fromFn: () => tileFrom(fromId),
    after: (s) => {
      bind(s, 'kalshi');
      // The list may have changed elsewhere (another tab): redraw only if nothing is being typed.
      const had = connections().length;
      void loadConnections().then(() => {
        const typing = [...s.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.ac-form input[type="text"], .ac-form textarea')].some((x) => x.value);
        if (s.isConnected && !typing && connections().length !== had) {
          refill(bodyHTML('kalshi'));
          bind(s, 'kalshi');
        }
      });
    },
  });
}
