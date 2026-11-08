/**
 * The speed rules on a phone (design.md section 13): at most 4 moving layers at rest, nothing moving inside the glass,
 * only transform and opacity animated, moving wallpaper layers small and without a mask. Run on the real board in a
 * real browser, per theme and mode, and read from the CSS files themselves for the keyframes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, BOARD } from '@app/contracts';
import { listThemes } from '@app/design-kit';
import { clientFromEnv } from '@app/service-kit';
import { WEB_URL, stackEnv, stackService } from './stack.ts';

const THEMES = listThemes();
const MODES = ['light', 'dark'] as const;
const ALLOWED = new Set(['transform', 'translate', 'rotate', 'scale', 'opacity']);

const cssFiles = () => {
  const dirs = [join(import.meta.dirname, '../src'), join(import.meta.dirname, '../../packages/design-kit/css'), join(import.meta.dirname, '../../packages/design-kit/css/themes')];
  return dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.css')).map((f) => join(d, f)));
};

/** Every property a @keyframes block animates, by the block's name. */
function keyframeProps(css: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < text.length && depth) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    const body = text.slice(start, i - 1);
    const props = out.get(m[1]!) ?? new Set<string>();
    for (const d of body.matchAll(/([-\w]+)\s*:/g)) props.add(d[1]!);
    out.set(m[1]!, props);
  }
  return out;
}

describe('Speed rules: the CSS files', () => {
  it('@keyframes animate only transform and opacity', () => {
    const bad: string[] = [];
    for (const f of cssFiles())
      for (const [name, props] of keyframeProps(readFileSync(f, 'utf8')))
        for (const p of props) if (!ALLOWED.has(p)) bad.push(`${f.split('/').slice(-2).join('/')} @keyframes ${name}: ${p}`);
    expect(bad).toEqual([]);
  });
});

interface Layer {
  el: string;
  inGlass: boolean;
  w: number;
  h: number;
  area: number;
  mask: boolean;
  props: string[];
}

/** The animations running forever, one entry per moving layer (element or pseudo-element), on the page as it stands. */
const census = (page: Page) =>
  page.evaluate(() => {
    const inGlass = (el: Element) => {
      for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
        const b = getComputedStyle(n).backdropFilter;
        if (b && b !== 'none') return true;
      }
      return false;
    };
    const layers = new Map<string, Layer & { node: Element; pseudo: string }>();
    let k = 0;
    const ids = new Map<Element, number>();
    for (const an of document.getAnimations()) {
      if (!(an instanceof CSSAnimation) || an.playState !== 'running') continue;
      const ef = an.effect as KeyframeEffect | null;
      const el = ef?.target as Element | null | undefined;
      if (!ef || !el || ef.getComputedTiming().iterations !== Infinity) continue;
      if (!ids.has(el)) ids.set(el, k++);
      const pseudo = ef.pseudoElement ?? '';
      const key = ids.get(el) + pseudo;
      const props = new Set<string>();
      for (const f of ef.getKeyframes()) for (const p of Object.keys(f)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
      const cur = layers.get(key);
      if (cur) cur.props.push(...props);
      else {
        const cs = getComputedStyle(el, pseudo || null);
        const r = el.getBoundingClientRect();
        // The layer's own size, not its bounding box: a rotated thin strip is not a big layer.
        const w = parseFloat(cs.width) || r.width;
        const h = parseFloat(cs.height) || r.height;
        const mi = cs.maskImage || (cs as unknown as { webkitMaskImage?: string }).webkitMaskImage || 'none';
        layers.set(key, { node: el, pseudo, el: `${el.tagName.toLowerCase()}.${el.className}${pseudo}`, inGlass: inGlass(el), w: Math.round(w), h: Math.round(h), area: Math.round(w * h), mask: mi !== 'none', props: [...props] });
      }
    }
    return { screen: innerWidth * innerHeight, vw: innerWidth, vh: innerHeight, layers: [...layers.values()].map(({ node: _n, pseudo: _p, ...l }) => l) };
  });

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const onBoard = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
  const email = `speed-${Date.now()}@example.com`;
  const password = 'a long test password';
  const env = { ...stackEnv(), EDGE_URL_ACCOUNTS: stackService('accounts'), EDGE_URL_BOARD: stackService('board') };
  const made = await (await clientFromEnv('edge', 'accounts', env))(ACCOUNTS.signup, { body: { email, password } });
  await (await clientFromEnv('edge', 'board', env))(BOARD.createDefaults, { params: { account_id: made.account.account_id }, body: { category: 'sports' } });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'light' });
  page = await ctx.newPage();
  await page.goto(WEB_URL + '/');
  // Log in rather than sign up: the web files share edge's small sign-up budget, so this file makes its account at accounts itself.
  await page.getByRole('tab', { name: 'Log in' }).tap();
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Log in' }).last().tap();
  await onBoard(page);
  await page.waitForTimeout(3000); // the boot animations end
});
afterAll(async () => {
  await browser?.close();
});

describe('Speed rules: the board on a phone, per theme and mode', () => {
  it('at most 4 moving layers, none inside the glass, small, no mask, only transform and opacity', async () => {
    const bad: string[] = [];
    for (const t of THEMES)
      for (const mode of MODES) {
        await page.evaluate(([id, m]) => {
          document.documentElement.dataset.theme = id;
          document.documentElement.dataset.mode = m;
        }, [t.id, mode] as const);
        await page.waitForTimeout(350);
        const c = await census(page);
        const tag = `${t.id} ${mode}`;
        if (c.layers.length > 4) bad.push(`${tag}: ${c.layers.length} moving layers: ${c.layers.map((l) => l.el).join(', ')}`);
        for (const l of c.layers) {
          if (l.inGlass) bad.push(`${tag}: ${l.el} moves inside the glass`);
          if (l.mask) bad.push(`${tag}: ${l.el} moves with a mask`);
          if (l.area >= c.screen || (l.w >= c.vw && l.h >= c.vh)) bad.push(`${tag}: ${l.el} is oversized (${l.w}x${l.h} on ${c.vw}x${c.vh})`);
          const off = l.props.filter((p) => !ALLOWED.has(p));
          if (off.length) bad.push(`${tag}: ${l.el} animates ${off.join(', ')}`);
        }
        const total = c.layers.reduce((s, l) => s + l.area, 0);
        if (total > 2 * c.screen) bad.push(`${tag}: moving layers cover ${(total / c.screen).toFixed(2)} screens`);
      }
    expect(bad).toEqual([]);
  });

  it('the hue slider re-tints the board at most once a frame, and the last value lands on release', async () => {
    await page.locator('#look-btn').tap();
    await page.waitForSelector('#lk-range');
    const r = await page.evaluate(async () => {
      const html = document.documentElement;
      let writes = 0;
      const mo = new MutationObserver((m) => (writes += m.length));
      mo.observe(html, { attributes: true, attributeFilter: ['style'] });
      const rg = document.querySelector<HTMLInputElement>('#lk-range')!;
      for (let i = 0; i < 50; i++) {
        rg.value = String(i * 4);
        rg.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise((res) => setTimeout(res, 300));
      const during = writes;
      rg.value = '245';
      rg.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((res) => setTimeout(res, 50));
      mo.disconnect();
      return { during, hue: ((Number(html.style.getPropertyValue('--hue')) % 360) + 360) % 360, live: html.classList.contains('hue-live') };
    });
    expect(r.during).toBeLessThanOrEqual(2);
    expect(r).toMatchObject({ hue: 245, live: false });
    await page.keyboard.press('Escape');
  });

  it('desktop: when the chat panel closes the board glides with a transform', async () => {
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', storageState: await ctx.storageState() });
    const p = await desk.newPage();
    await p.goto(WEB_URL + '/');
    await onBoard(p);
    await p.waitForTimeout(1500);
    const before = await p.evaluate(() => document.querySelector('#board')!.getBoundingClientRect().left);
    await p.locator('#chat-close').click();
    const glide = await p.evaluate(() =>
      document
        .querySelector('#board')!
        .getAnimations()
        .flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().map((k) => Object.keys(k).filter((x) => !['offset', 'computedOffset', 'easing', 'composite'].includes(x))))
        .flat(),
    );
    expect(await p.evaluate(() => document.documentElement.classList.contains('chat-hidden'))).toBe(true);
    expect(glide).toContain('transform');
    await expect.poll(() => p.evaluate(() => document.querySelector('#board')!.getAnimations().length), { timeout: 15_000 }).toBe(0);
    expect(await p.evaluate(() => document.querySelector('#board')!.getBoundingClientRect().left)).not.toBe(before);
    await desk.close();
  });
});
