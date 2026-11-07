import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_IDS } from '@app/contracts';
import { BASE_CSS, attentionOutsideNeeds, checkTheme, listThemes } from '../src/index.ts';

const themes = listThemes();

describe('design kit', () => {
  it('has themes, each with a unique id from THEME_IDS', () => {
    expect(themes.length).toBeGreaterThan(0);
    const ids = themes.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(THEME_IDS as readonly string[]).toContain(id);
  });

  for (const t of themes) {
    it(`${t.file} follows the theme contract`, () => {
      expect(checkTheme(t.css, t.id)).toEqual([]);
    });
  }

  it('uses the attention color only for "needs you"', () => {
    expect(attentionOutsideNeeds(readFileSync(BASE_CSS, 'utf8'))).toEqual([]);
    for (const t of themes) expect(attentionOutsideNeeds(t.css), t.file).toEqual([]);
  });

  it('loads nothing from the network: no @import, no font files, no external url()', () => {
    for (const css of [readFileSync(BASE_CSS, 'utf8'), ...themes.map((t) => t.css)]) {
      expect(css).not.toMatch(/@import|@font-face/i);
      expect(css).not.toMatch(/url\(\s*["']?(https?:|\/\/)/i);
    }
  });

  it('catches a broken theme', () => {
    const bad = '[data-theme="ice"] { --text: red; } [data-theme="ice"] .w { width: 3px; } .bar { color: red; }';
    const errs = checkTheme(bad, 'ice');
    expect(errs.some((e) => e.includes('missing --wallpaper'))).toBe(true);
    expect(errs.some((e) => e.includes('layout property "width"'))).toBe(true);
    expect(errs.some((e) => e.includes('selector not under'))).toBe(true);
  });
});
