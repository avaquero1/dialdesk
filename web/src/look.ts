/**
 * The look: theme, mode and hue on <html> (the design kit's contract). It is applied live and saved to accounts
 * through edge; look.changed from another tab or the chat agent applies here without a save.
 */
import type { Look } from '@app/contracts';
import { cssNum, raf2, root } from './dom.ts';

declare const __THEMES__: { id: string; name: string }[];
/** The themes this bundle carries (every file in packages/design-kit/css/themes), baked in by web/build.ts. */
export const THEMES: { id: string; name: string }[] = __THEMES__;
export const hasTheme = (id: string) => THEMES.some((t) => t.id === id);

export const L: Look = { theme: (THEMES[0]?.id ?? 'agent-mail') as Look['theme'], mode: 'system', hue: null };
export const mqDark = matchMedia('(prefers-color-scheme: dark)');
export const resolveMode = () => (L.mode === 'system' ? (mqDark.matches ? 'dark' : 'light') : L.mode);
export const themeHue = () => cssNum('--hue-default', 220);

let hueNow: number | null = null;
/** Writes --hue, always the short way round the circle, so the 900 ms glide never spins the long way. */
function applyHue(how?: 'instant' | 'live') {
  const target = L.hue != null ? L.hue : themeHue();
  if (hueNow == null || how === 'instant') hueNow = target;
  else hueNow += ((((target - hueNow) % 360) + 540) % 360) - 180;
  if (how) root.classList.add('hue-live');
  root.style.setProperty('--hue', String(Math.round(hueNow * 100) / 100));
  if (how === 'instant') raf2(() => root.classList.remove('hue-live'));
}

export interface LookHooks {
  /** After the theme changed (sizes and radii may differ): re-measure the board. */
  onThemeChanged: () => void;
  /** After the mode changed: rebuild the refraction maps. */
  onModeChanged: () => void;
  /** After any change: refresh an open Look sheet. */
  onSynced: () => void;
  save: (look: Look) => Promise<unknown>;
}
let hooks: LookHooks | null = null;
let saveT = 0;
let saved = JSON.stringify(L);

export function initLook(h: LookHooks, start: Look) {
  hooks = h;
  L.theme = hasTheme(start.theme) ? start.theme : L.theme;
  L.mode = start.mode;
  L.hue = start.hue;
  saved = JSON.stringify(start);
  root.dataset.theme = L.theme;
  root.dataset.mode = resolveMode();
  applyHue('instant');
  mqDark.addEventListener('change', () => {
    if (L.mode === 'system') setLook({}, { save: false });
  });
}

/**
 * Changes the look. `save: false` for changes that came from the server. `how: 'live'` while the hue slider moves
 * (no glide, and the save waits until the slider rests).
 */
export function setLook(o: Partial<Look>, opt: { how?: 'instant' | 'live'; save?: boolean } = {}) {
  const themeChanged = !!(o.theme && o.theme !== L.theme && hasTheme(o.theme));
  if (themeChanged) L.theme = o.theme!;
  if (o.mode) L.mode = o.mode;
  if ('hue' in o) L.hue = o.hue == null ? null : Math.round(((o.hue % 361) + 361) % 361);
  const modeBefore = root.dataset.mode;
  root.dataset.theme = L.theme;
  root.dataset.mode = resolveMode();
  applyHue(opt.how);
  if (themeChanged) hooks?.onThemeChanged();
  else if (modeBefore !== root.dataset.mode) hooks?.onModeChanged();
  hooks?.onSynced();
  if (opt.save !== false) queueSave(opt.how === 'live' ? 450 : 0);
}

function queueSave(ms: number) {
  clearTimeout(saveT);
  saveT = window.setTimeout(() => {
    const look: Look = { theme: L.theme, mode: L.mode, hue: L.hue };
    const s = JSON.stringify(look);
    if (s === saved || !hooks) return;
    saved = s;
    hooks.save(look).catch(() => {
      saved = '';
    });
  }, ms);
}

/** look.changed from the server (another tab, or the agent's set_look): apply it, no save. */
export function lookFromServer(look: Look) {
  saved = JSON.stringify(look);
  setLook(look, { save: false });
}
