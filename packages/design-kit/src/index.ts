/**
 * The design kit: the base board CSS (css/base.css) and one CSS file per glass theme (css/themes/NN-slug.css).
 * This module lists the themes and holds the theme contract, so the web build and the tests read the same rules.
 * Node only (it reads files); the browser gets the list baked into its bundle by web/build.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const KIT_DIR = join(import.meta.dirname, '..');
export const BASE_CSS = join(KIT_DIR, 'css', 'base.css');
export const THEMES_DIR = join(KIT_DIR, 'css', 'themes');

/** Display names by file number. A file without a number gets its slug in title case. */
const NAMES: Record<string, string> = {
  '01': 'Agent Mail',
  '02': 'Clear Water',
  '03': 'Mercury',
  '04': 'Stadium Night',
  '05': 'Deep Sea',
  '06': 'Ice',
  '07': 'Aurora',
  '08': 'Prism',
  '09': 'Obsidian',
  '10': 'Rain',
  '11': 'Daybreak',
  '12': 'Ink in Water',
};
const SMALL = new Set(['in', 'of', 'the', 'and']);
const titleCase = (slug: string) =>
  slug
    .split('-')
    .map((w, i) => (i && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');

export interface ThemeFile {
  id: string;
  name: string;
  file: string;
  css: string;
}

/** Every theme file, sorted by name. The id is the first `[data-theme="…"]` in the file. */
export function listThemes(dir = THEMES_DIR): ThemeFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((file) => {
      const css = readFileSync(join(dir, file), 'utf8');
      const id = /\[data-theme="([^"]+)"\]/.exec(css)?.[1];
      if (!id) throw new Error(`${file}: no [data-theme="…"] selector`);
      const num = /^(\d+)-/.exec(file)?.[1];
      const slug = file.replace(/^\d+-/, '').replace(/\.css$/, '');
      return { id, name: (num && NAMES[num]) || titleCase(slug), file, css };
    });
}

// ---------- the theme contract ----------

const SIDES = ['widget', 'panel', 'chip', 'bar'] as const;
const PARTS = ['bg', 'blur', 'sat', 'rim', 'top', 'shadow', 'sheen'] as const;
export const GLASS_TOKENS = SIDES.flatMap((s) => PARTS.map((p) => `--glass-${s}-${p}`));
const INKS = [1, 2, 3, 4, 5, 6].map((n) => `--ink-${n}`);
/** Tokens that change with the mode: the light block and the dark block both set them. */
export const MODE_TOKENS = [
  '--wallpaper',
  '--text',
  '--text-2',
  '--text-3',
  '--text-on-accent',
  '--accent',
  '--attention',
  '--danger',
  '--ok',
  '--up',
  '--down',
  '--flat',
  ...INKS,
  ...GLASS_TOKENS,
  '--refraction',
  '--specular',
];
/** Tokens set once, in the light block. */
export const FIXED_TOKENS = [
  '--hue-default',
  '--font-ui',
  '--font-num',
  '--font-display',
  '--r-widget',
  '--r-panel',
  '--r-chip',
  '--gap',
  '--pad',
  '--ease-water',
  '--t-water',
  '--ease-honey',
  '--t-honey',
  '--ease-pour',
  '--t-pour',
  '--ease-drain',
  '--t-drain',
  '--lift-scale',
  '--wobble',
];
const LAYOUT =
  /^(position|display|width|height|min-width|min-height|max-width|max-height|margin|margin-\w+|padding|padding-\w+|top|right|bottom|left|inset|z-index|float|flex|flex-\w+|grid|grid-\w+|gap|row-gap|column-gap|translate|scale|rotate|transform|overflow|overflow-\w+|aspect-ratio)$/;
const COLOR = /^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\(|color-mix\(|transparent|currentcolor|[a-z]+$)/i;
const GLASS_TYPE: Record<(typeof PARTS)[number], (v: string) => boolean> = {
  bg: (v) => COLOR.test(v) || /gradient\(/.test(v),
  blur: (v) => /^\d+(\.\d+)?px$/.test(v),
  sat: (v) => /^\d+(\.\d+)?%$/.test(v),
  rim: (v) => COLOR.test(v),
  top: (v) => COLOR.test(v),
  shadow: (v) => v === 'none' || /\d+(\.\d+)?px/.test(v),
  sheen: (v) => v === 'none' || /gradient\(/.test(v),
};
/** Themes that keep raster art (data: SVG noise): their size, url() and one @supports block are accepted. */
export const ART_EXCEPTIONS = new Set(['mercury']);
export const THEME_MAX_BYTES = 40 * 1024;

interface Rule {
  sel: string;
  body: string;
  at: string;
  keyframes?: boolean;
  otherAt?: boolean;
}

export const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function walk(text: string, at = ''): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const body = text.slice(open + 1, j - 1);
    if (head.startsWith('@media')) out.push(...walk(body, head));
    else if (head.startsWith('@keyframes')) out.push({ sel: head, body: '', at, keyframes: true });
    else if (head.startsWith('@')) out.push({ sel: head, body, at, otherAt: true });
    else out.push({ sel: head, body, at });
    i = j;
  }
  return out;
}

const decls = (body: string) =>
  body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const k = d.indexOf(':');
      return [d.slice(0, k).trim(), d.slice(k + 1).trim()] as const;
    });

/** Splits a selector list at top-level commas only (`:is(a, b)` stays whole). */
function selectors(sel: string): string[] {
  const parts: string[] = [];
  let d = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') d++;
    if (ch === ')' || ch === ']') d--;
    if (ch === ',' && !d) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

/**
 * Checks one theme file against the contract. Returns the problems (empty = it follows the contract):
 * a token missing from the light or dark block, a glass token of the wrong type, a selector outside the theme,
 * a layout property outside the paint layers, @import / @font-face / url(), or a file over 40 KB.
 */
export function checkTheme(raw: string, id: string): string[] {
  const css = stripComments(raw);
  const rules = walk(css);
  const errors: string[] = [];
  const art = ART_EXCEPTIONS.has(id);
  const lightSel = `[data-theme="${id}"]`;
  const darkSel = `[data-theme="${id}"][data-mode="dark"]`;
  const block = (sel: string) => rules.filter((r) => !r.at && !r.keyframes && r.sel === sel).flatMap((r) => decls(r.body));
  const light = block(lightSel);
  const dark = block(darkSel);
  const has = (b: readonly (readonly [string, string])[], t: string) => b.some(([k]) => k === t);

  for (const t of [...MODE_TOKENS, ...FIXED_TOKENS]) if (!has(light, t)) errors.push(`light block is missing ${t}`);
  for (const t of MODE_TOKENS) if (!has(dark, t)) errors.push(`dark block is missing ${t}`);
  for (const [mode, b] of [['light', light], ['dark', dark]] as const) {
    for (const [k, v] of b) {
      const m = /^--glass-(widget|panel|chip|bar)-(bg|blur|sat|rim|top|shadow|sheen)$/.exec(k);
      if (m && !GLASS_TYPE[m[2] as (typeof PARTS)[number]](v)) errors.push(`${mode}: ${k} is not a valid ${m[2]}: ${v.slice(0, 60)}`);
    }
  }
  for (const r of rules) {
    if (r.keyframes) continue;
    if (r.otherAt) {
      if (!art) errors.push(`unexpected at-rule: ${r.sel}`);
      continue;
    }
    const parts = selectors(r.sel);
    for (const p of parts) if (!p.startsWith(lightSel)) errors.push(`selector not under ${lightSel}: ${p}`);
    // Paint layers (.wallpaper-fx, ::before, ::after) may position themselves; nothing else may.
    const paint = parts.every((p) => p.includes('.wallpaper-fx') || /::(before|after)$/.test(p));
    if (!paint) for (const [k] of decls(r.body)) if (LAYOUT.test(k)) errors.push(`layout property "${k}" in: ${r.sel.slice(0, 80)}`);
  }
  if (/@import|@font-face/i.test(css)) errors.push('@import or @font-face (themes use system fonts only)');
  const noRefs = css.replace(/url\(#[^)]*\)/g, '');
  if (/url\(/i.test(noRefs)) {
    // A theme never loads a file. Only an exception's inline data: art is accepted.
    const noData = noRefs.replace(/url\(\s*"data:[^"]*"\s*\)|url\(\s*'data:[^']*'\s*\)|url\(\s*data:[^)]*\)/gi, '');
    if (/url\(/i.test(noData) || !art) errors.push('url() found (themes use gradients, not files)');
  }
  if (!art && Buffer.byteLength(raw) > THEME_MAX_BYTES) errors.push(`file is ${(Buffer.byteLength(raw) / 1024).toFixed(1)} KB (limit 40 KB)`);
  return errors;
}

/** The attention color means only "this needs you": no rule outside a `.needs` selector may use it. */
export function attentionOutsideNeeds(css: string): string[] {
  const out: string[] = [];
  for (const chunk of stripComments(css).split('}')) {
    const i = chunk.lastIndexOf('{');
    if (i < 0) continue;
    const sel = chunk.slice(0, i);
    const body = chunk.slice(i + 1).replace(/--attention\s*:[^;]*;?/g, '');
    if (/--attention/.test(body) && !/\.needs/.test(sel)) out.push(sel.trim().split('\n').pop()!.slice(0, 90));
  }
  return out;
}
