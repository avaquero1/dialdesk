/**
 * Two apps: Add (inside: Catalog) and Settings.
 *
 * Add: one row per display type, in plain words. A tap adds one widget of that type on this week's games, the way the
 * first board picks them (edge's POST /api/widgets: proposed and accepted at once), the sheet drains and the widget pours
 * in on the board like an accepted proposal. A one-game display (a market, Two prices, News) first asks "Which game?"
 * with a chip per game of this week ("Jets at Chiefs, Sun 1 PM"), the most traded first; with no games to choose (markets
 * down, or only the catalog's made-up games) it adds at once, as before.
 *
 * Settings: the Look (theme, mode, hue: the Look sheet), the easier-to-see switches (reduced motion, reduced
 * transparency, glass refraction; per device, in localStorage), sign out, and the plain line.
 */
import type { DisplayType } from '@app/contracts';
import { api } from './api.ts';
import { esc, reduced, root } from './dom.ts';
import { buildLens } from './board.ts';
import { IC } from './icons.ts';
import { L, THEMES } from './look.ts';
import { closeSurface, openLook, rz, sheetHead, toast } from './surfaces.ts';

/** The display types on screen (design section 6), in the order the first board shows them. */
export const ADD_TYPES: { type: DisplayType; name: string; what: string }[] = [
  { type: 'events', name: 'Tonight', what: "Tonight's games, each with its chance and its move" },
  { type: 'probability', name: 'A market', what: 'One game: its chance, its move and both exchanges' },
  { type: 'gap', name: 'Two prices', what: 'The same game on Kalshi and Polymarket, and the gap' },
  { type: 'news', name: 'News', what: 'Short news items for a team, read in sealed boxes' },
  { type: 'positions', name: 'Your account', what: 'A connected account, read only' },
  { type: 'movement', name: 'Biggest move', what: "One market's move and a small line" },
];

export const PLAIN_LINE = 'Math from public data. Not investment advice.';

export function addBody() {
  let i = 2;
  return (
    sheetHead('Add', 'One tap adds a widget with its usual settings. Change it later with the agent.') +
    ADD_TYPES.map(
      (t) =>
        `<button class="rowitem add-row${rz(i++)} type="button" data-add="${esc(t.type)}"><span class="ic">${IC.catalog}</span>` +
        `<div class="grow"><div class="t">${esc(t.name)}</div><div class="s">${esc(t.what)}</div></div><span class="add-plus" aria-hidden="true">+</span></button>`,
    ).join('')
  );
}

/** The displays that follow one game (board's ONE_GAME): Add asks which. */
const ONE_GAME = new Set<DisplayType>(['probability', 'gap', 'news']);

let adding = false;
/** A tap on an Add row or a game chip. boardChanged fetches the board, so the new widget pours in. */
export async function addClick(e: Event, boardChanged: () => void) {
  const b = (e.target as Element).closest<HTMLButtonElement>('[data-add]');
  if (!b || adding) return;
  const t = ADD_TYPES.find((x) => x.type === b.dataset.add);
  if (!t) return;
  const game = b.dataset.game;
  adding = true;
  b.setAttribute('aria-busy', 'true');
  try {
    if (!game && ONE_GAME.has(t.type) && (await askWhichGame(b, t.type))) return b.removeAttribute('aria-busy');
    await api.addWidget(t.type, game);
    closeSurface();
    boardChanged();
    toast(`${game ? b.textContent!.split(',')[0] : t.name} added to your board.`);
  } catch {
    b.removeAttribute('aria-busy');
    toast(`Couldn't add ${t.name} right now. Try again in a moment.`);
  } finally {
    adding = false;
  }
}

/**
 * "Which game?" under the row: this week's games as chips. false: nothing to choose (or the list didn't come), so the
 * row adds the default at once. A second tap on the row closes the question.
 */
async function askWhichGame(row: HTMLButtonElement, type: DisplayType): Promise<boolean> {
  const open = row.nextElementSibling?.classList.contains('add-games') ? row.nextElementSibling : null;
  row.parentElement?.querySelectorAll('.add-games').forEach((x) => x.remove());
  row.parentElement?.querySelectorAll('.add-row[aria-expanded]').forEach((x) => x.removeAttribute('aria-expanded'));
  if (open) return true;
  const choices = await api.addChoices(type).then((r) => r.choices, () => []);
  if (!choices.length) return false;
  row.setAttribute('aria-expanded', 'true');
  row.insertAdjacentHTML(
    'afterend',
    `<div class="add-games" role="group" aria-label="Which game?"><h3 class="sf-h">Which game?</h3><div class="add-chips">` +
      choices.map((c) => `<button class="add-game" type="button" data-add="${esc(type)}" data-game="${esc(c.event_key)}">${esc(c.label)}</button>`).join('') +
      `</div></div>`,
  );
  row.nextElementSibling?.querySelector<HTMLElement>('.add-game')?.focus({ preventScroll: true });
  return true;
}

// ---------- Settings ----------

const MODE_NAME: Record<string, string> = { light: 'Light', dark: 'Dark', system: 'System' };
const lookLine = () => {
  const theme = THEMES.find((t) => t.id === L.theme)?.name ?? L.theme;
  return `${theme} · ${MODE_NAME[L.mode] ?? L.mode} · ${L.hue == null ? "the theme's color" : `hue ${Math.round(L.hue)}°`}`;
};

export function settingsBody() {
  const toggle = (k: string, on: boolean, label: string, sub: string, i: number) =>
    `<div class="rowitem${rz(i)}><div class="grow"><div class="t">${esc(label)}</div><div class="s">${esc(sub)}</div></div><button class="toggle" type="button" data-toggle="${k}" aria-pressed="${on}" aria-label="${esc(label)}"></button></div>`;
  return (
    sheetHead('Settings') +
    `<h3 class="sf-h${rz(1)}>Look</h3>` +
    `<button class="rowitem how-row${rz(2)} type="button" data-open-look><span class="ic">${IC.settings}</span><div class="grow"><div class="t">Theme, mode and color</div><div class="s" id="set-look">${esc(lookLine())}</div></div><span class="caret">${IC.caret}</span></button>` +
    `<h3 class="sf-h${rz(3)}>Easier to see</h3>` +
    toggle('motion', reduced(), 'Reduced motion', 'Every change becomes a short fade', 4) +
    toggle('transparency', root.dataset.transparency === 'reduced', 'Reduced transparency', 'Solid glass instead of see-through', 5) +
    toggle('refract', root.dataset.refract === '1', 'Glass refraction', 'Bends the wallpaper at the glass edge (Chromium)', 6) +
    `<h3 class="sf-h${rz(7)}>Account</h3>` +
    `<div class="sh-sec${rz(8)}><button class="btn" type="button" data-signout><span class="ic-inline">${IC.logout}</span><span>Sign out</span></button></div>` +
    `<p class="set-plain${rz(9)}>${esc(PLAIN_LINE)}</p>`
  );
}

/** A tap in Settings. */
export function settingsClick(e: Event, logout: () => void) {
  const el = e.target as Element;
  if (el.closest('[data-open-look]')) {
    closeSurface(true);
    return void openLook();
  }
  if (el.closest('[data-signout]')) {
    closeSurface(true);
    return void logout();
  }
  const t = el.closest<HTMLElement>('[data-toggle]');
  if (!t) return;
  const on = t.getAttribute('aria-pressed') !== 'true';
  t.setAttribute('aria-pressed', String(on));
  if (t.dataset.toggle === 'motion') root.dataset.motion = on ? 'reduced' : 'full';
  else if (t.dataset.toggle === 'transparency') root.dataset.transparency = on ? 'reduced' : 'full';
  else {
    root.dataset.refract = on ? '1' : '0';
    buildLens();
  }
  savePrefs();
}

/** Per-device display preferences (not the look, which lives in the account). */
export function savePrefs() {
  try {
    localStorage.setItem('prefs', JSON.stringify({ motion: root.dataset.motion, refract: root.dataset.refract, transparency: root.dataset.transparency }));
  } catch {
    /* storage blocked: the preference lasts for this page only */
  }
}
