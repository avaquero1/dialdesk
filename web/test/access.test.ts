/**
 * Access rules on a phone (design.md section 12), per theme, mode and hue, on the first board and the open Look sheet.
 *
 * How contrast is judged: glass over a wallpaper has no single background color, so the test measures pixels. For each
 * state it hides every text (the glyphs only; backgrounds, glass and wallpaper stay), takes one screenshot, and for each
 * line of each visible text reads every second pixel behind the line's box (1 px inside it). The text's own color, with
 * its alpha and its ancestors' opacity, is blended over each of those pixels and the contrast (WCAG) is taken against
 * that same pixel. The text's score is its WORST pixel, and it must be at least 4.5. A text shadow or glow doesn't count.
 * Disabled controls are exempt, as in WCAG. Gradient-filled numbers (Mercury) are judged on each gradient stop.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, BOARD } from '@app/contracts';
import { listThemes } from '@app/design-kit';
import { clientFromEnv } from '@app/service-kit';
import { WEB_URL, stackEnv, stackService } from './stack.ts';

const THEMES = listThemes();
const MODES = ['light', 'dark'] as const;
/** Each theme's own hue, then yellow (the lightest accents) and blue-violet (the darkest), half the circle apart. */
const HUES = [null, 95, 275] as const;
const SHOTS = process.env.ACCESS_SHOTS;
const MIN_CONTRAST = 4.5;
const BODY_PX = 16;
const LABEL_PX = 12;
const TARGET_PX = 44;

/**
 * The small labels on a tile or a control that may stay under 16 px (at least 12 px) because the tile can't fit more.
 * Anything not listed here is something a person reads (notes, summaries, sheet paragraphs, messages, buttons' words) and
 * must be at least 16 px. The list of what actually stays small goes to access-under-16.json when ACCESS_SHOTS is set.
 */
const LABELS = [
  '.w-sub', '.lbl', '.w-foot', '.item .meta', '.w-title', '.mini', '.mini s', '.g-lab', '.game .g-n', '.mv', '.mv-a', '.pillnote',
  '.c-ex', '.c-span', '.pos-meta', '.pos-list', '.pos-mvs', '.who', '.okline', '.a-label', '.card .n', '.needs', '.wchip',
  '.tool-chip', '.foot', '.chip', '.hue-val', '.w-live', '.stat .k', '.sh-sec > h4', '.w--s .w-note', '.w--s .w-empty', '.w--s .item--blocked .hl', '.g-p', '.big-u', '.w--m .item .hl', '.w--m .item--blocked .hl', '.w--m .w-note', '.g-game',
];

type Rgba = [number, number, number, number];
interface TextBox {
  key: string;
  text: string;
  px: number;
  colors: Rgba[];
  alpha: number;
  disabled: boolean;
  label: boolean;
  boxes: [number, number, number, number][];
}
interface Target {
  key: string;
  w: number;
  h: number;
}

/** The look on <html>, as the app sets it, in place (no glide). */
const setLook = (page: Page, theme: string, mode: string, hue: number | null, transparency: 'full' | 'reduced' = 'full') =>
  page.evaluate(
    async ([t, m, h, tr]) => {
      const root = document.documentElement;
      root.classList.add('hue-live');
      root.dataset.theme = t as string;
      root.dataset.mode = m as string;
      root.dataset.transparency = tr as string;
      root.style.setProperty('--hue', h == null ? getComputedStyle(root).getPropertyValue('--hue-default').trim() : String(h));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    [theme, mode, hue, transparency] as const,
  );

/** Every visible text's color, size and boxes, and every control's hit box, on the page as it stands. */
const collect = (page: Page, labels: string[]) =>
  page.evaluate((labelSel) => {
    const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgba = (css: string): Rgba => {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = '#000';
      paint.fillStyle = css;
      paint.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data as unknown as number[];
      return a ? [(r! * 255) / a!, (g! * 255) / a!, (b! * 255) / a!, a! / 255] : [0, 0, 0, 0];
    };
    const surf = (e: Element | null) => e?.closest('.surface, .chat, .bar, .w, .scrim, .foot') ?? null;
    const visible = (el: Element) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility !== 'visible') return false;
      if (el.closest('.sr, [aria-hidden="true"]')) return false;
      return true;
    };
    const opacity = (el: Element) => {
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
      return o;
    };
    /** The part of a box that shows: inside the screen and inside every clipping ancestor. */
    const clip = (r: DOMRect, el: Element) => {
      let [l, t, rt, b] = [Math.max(r.left, 0), Math.max(r.top, 0), Math.min(r.right, innerWidth), Math.min(r.bottom, innerHeight)];
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (getComputedStyle(n).overflow === 'visible') continue;
        const c = n.getBoundingClientRect();
        [l, t, rt, b] = [Math.max(l, c.left), Math.max(t, c.top), Math.min(rt, c.right), Math.min(b, c.bottom)];
      }
      return { l, t, r: rt, b };
    };
    const onTop = (x: number, y: number, el: Element) => {
      const top = document.elementFromPoint(x, y);
      if (!top) return false;
      return top === el || top.contains(el) || el.contains(top) || surf(top) === surf(el);
    };
    const keyOf = (el: Element) => {
      const cls = [...el.classList].slice(0, 2).join('.');
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
    };

    const texts: TextBox[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = (node.nodeValue ?? '').trim();
      const el = node.parentElement;
      if (!value || !el || el.closest('script, style, noscript, svg') || !visible(el)) continue;
      range.selectNodeContents(node);
      const boxes: [number, number, number, number][] = [];
      for (const r of range.getClientRects()) {
        if (r.width < 3 || r.height < 6) continue;
        const c = clip(r, el);
        if (c.r - c.l < 3 || c.b - c.t < 6) continue;
        if (!onTop((c.l + c.r) / 2, (c.t + c.b) / 2, el)) continue;
        boxes.push([c.l, c.t, c.r, c.b]);
      }
      if (!boxes.length) continue;
      const s = getComputedStyle(el);
      const clipped = (s.backgroundClip || s.webkitBackgroundClip) === 'text' || s.webkitBackgroundClip === 'text';
      const colors = clipped ? (s.backgroundImage.match(/(?:rgba?|oklch|oklab|lab|lch|color)\([^)]*\)/g) ?? [s.color]).map(rgba) : [rgba(s.color)];
      texts.push({
        key: keyOf(el),
        text: value.slice(0, 40),
        px: parseFloat(s.fontSize),
        colors,
        alpha: opacity(el),
        disabled: !!el.closest('[aria-disabled="true"], :disabled'),
        label: !!el.closest(labelSel),
        boxes,
      });
    }
    // Placeholders are text too, and they have no text node.
    for (const inp of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[placeholder], textarea[placeholder]')) {
      if (inp.value || !visible(inp)) continue;
      const r = inp.getBoundingClientRect();
      const c = clip(r, inp);
      if (c.r - c.l < 3 || c.b - c.t < 6 || !onTop((c.l + c.r) / 2, (c.t + c.b) / 2, inp)) continue;
      const s = getComputedStyle(inp, '::placeholder');
      texts.push({ key: `${keyOf(inp)}::placeholder`, text: inp.placeholder.slice(0, 40), px: parseFloat(s.fontSize), colors: [rgba(s.color)], alpha: opacity(inp), disabled: false, label: false, boxes: [[c.l + 8, c.t + 8, c.r - 8, c.b - 8]] });
    }

    const targets: Target[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], summary, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"]')) {
      if (!visible(el) || el.closest('[aria-disabled="true"], :disabled')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const c = clip(r, el);
      if (c.r - c.l < 2 || c.b - c.t < 2 || !onTop((c.l + c.r) / 2, (c.t + c.b) / 2, el)) continue;
      // A control may reach 44 px with a transparent hit area on an absolute pseudo-element around it.
      let [w, h] = [r.width, r.height];
      for (const p of ['::before', '::after']) {
        const cs = getComputedStyle(el, p);
        if (cs.content === 'none' || cs.position !== 'absolute' || cs.pointerEvents === 'none') continue;
        w = Math.max(w, parseFloat(cs.width) || 0);
        h = Math.max(h, parseFloat(cs.height) || 0);
      }
      targets.push({ key: `${keyOf(el)} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}"`, w: Math.round(w), h: Math.round(h) });
    }

    // A move down, and the start of the price lines: never in a color that reads as red, at any hue.
    const stop = document.querySelector('#sg .sg-a');
    const downs = [...document.querySelectorAll('.mv--down')].filter(visible).map((e) => rgba(getComputedStyle(e).color));
    const second = document.querySelector('.spark .l2');
    const cut = [...document.querySelectorAll<HTMLElement>('.bar .chip, .bar .chip .short, .c-foot .ev')]
      .filter((e) => visible(e) && (e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().bottom > (e.closest('.w')?.getBoundingClientRect().bottom ?? Infinity) - 4))
      .map(keyOf);
    return { texts, targets, cut, downs, lineStart: stop ? rgba(getComputedStyle(stop).stopColor) : null, lineTwo: second ? rgba(getComputedStyle(second).stroke) : null };
  }, labels.join(', '));

/** The hue of a color in OKLCH (degrees) and its chroma, enough to say whether it reads as red. */
function hueOf([r, g, b]: Rgba): { h: number; c: number } {
  const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122 * R + 0.5364 * G + 0.0514 * B);
  const m = Math.cbrt(0.2119 * R + 0.6807 * G + 0.1074 * B);
  const s = Math.cbrt(0.0883 * R + 0.2817 * G + 0.63 * B);
  const A = 1.9779985 * l - 2.428592 * m + 0.4505937 * s;
  const Bb = 0.0259040 * l + 0.7827717 * m - 0.808675 * s;
  return { h: (Math.atan2(Bb, A) * 180) / Math.PI, c: Math.hypot(A, Bb) };
}
/** Reads as red: real chroma and a hue from pink-red through red-orange. */
const readsRed = (c: Rgba) => {
  const { h, c: ch } = hueOf(c);
  return ch > 0.07 && h > -15 && h < 55;
};

/** One state: hide the glyphs, one screenshot, then every text's worst pixel. Checks sizes, targets and red in the same pass. */
async function checkState(page: Page, blank: Page, tag: string, bad: string[], under16: Map<string, Set<string>>): Promise<void> {
  const { texts, targets, cut, downs, lineStart, lineTwo } = await collect(page, LABELS);
  const hide = await page.evaluateHandle(() => {
    const s = new CSSStyleSheet();
    s.replaceSync(
      '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; transition: none !important; } ' +
        '.big { background-image: none !important; } ::placeholder { color: transparent !important; }',
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
    return s;
  });
  await page.waitForTimeout(60);
  const png = await page.screenshot({ type: 'png', animations: 'allow' });
  await hide.evaluate((s: CSSStyleSheet) => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s);
  });
  await hide.dispose();

  const worst = await blank.evaluate(
    async ([b64, list]) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = `data:image/png;base64,${b64}`;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      return (list as { boxes: number[][]; colors: number[][]; alpha: number }[]).map((t) => {
        let min = 21;
        let at: number[] = [];
        for (const fg of t.colors)
          for (const [l, top, r, b] of t.boxes) {
            const [x0, y0, x1, y1] = [Math.ceil(l!) + 1, Math.ceil(top!) + 1, Math.floor(r!) - 1, Math.floor(b!) - 1];
            for (let y = y0; y <= y1; y += 2)
              for (let x = x0; x <= x1; x += 2) {
                const i = (y * c.width + x) * 4;
                const bg = [data[i]!, data[i + 1]!, data[i + 2]!];
                const a = fg[3]! * t.alpha;
                const fgOn = [a * fg[0]! + (1 - a) * bg[0]!, a * fg[1]! + (1 - a) * bg[1]!, a * fg[2]! + (1 - a) * bg[2]!];
                const lum = (v: number[]) => {
                  const f = (u: number) => (u / 255 <= 0.03928 ? u / 255 / 12.92 : ((u / 255 + 0.055) / 1.055) ** 2.4);
                  return 0.2126 * f(v[0]!) + 0.7152 * f(v[1]!) + 0.0722 * f(v[2]!);
                };
                const [p, q] = [lum(fgOn), lum(bg)];
                const ratio = (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05);
                if (ratio < min) {
                  min = ratio;
                  at = bg;
                }
              }
          }
        return { min, at };
      });
    },
    [png.toString('base64'), texts.map((t) => ({ boxes: t.boxes, colors: t.colors, alpha: t.alpha }))] as const,
  );

  texts.forEach((t, i) => {
    if (t.disabled) return;
    const { min, at } = worst[i]!;
    if (min < MIN_CONTRAST) bad.push(`${tag}: contrast ${min.toFixed(2)} ${t.key} "${t.text}" (${t.px}px, on rgb(${at.join(',')}))`);
    if (t.px < LABEL_PX) bad.push(`${tag}: ${t.px}px under 12: ${t.key} "${t.text}"`);
    else if (t.px < BODY_PX) {
      if (!t.label) bad.push(`${tag}: ${t.px}px body text: ${t.key} "${t.text}"`);
      else {
        const k = `${t.key} @ ${t.px}px`;
        if (!under16.has(k)) under16.set(k, new Set());
        under16.get(k)!.add(t.text);
      }
    }
  });
  for (const t of targets) if (t.w < TARGET_PX || t.h < TARGET_PX) bad.push(`${tag}: target ${t.w}x${t.h} ${t.key}`);
  for (const k of cut) bad.push(`${tag}: words are cut: ${k}`);
  for (const c of downs) if (readsRed(c)) bad.push(`${tag}: a move down in a red color rgb(${c.slice(0, 3).map(Math.round).join(',')})`);
  if (lineStart && readsRed(lineStart)) bad.push(`${tag}: the price line starts red rgb(${lineStart.slice(0, 3).map(Math.round).join(',')})`);
  if (lineTwo && readsRed(lineTwo)) bad.push(`${tag}: the second price line is red rgb(${lineTwo.slice(0, 3).map(Math.round).join(',')})`);
}

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let blank: Page;
const onBoard = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const openLook = async () => {
  await page.locator('#look-btn').click();
  await page.waitForSelector('#lk-range');
  await page.waitForTimeout(1500);
};
const closeLook = async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
};
const uniq = (xs: string[]) => [...new Set(xs)];
/** The board at its top, or scrolled to its end (the lower tiles, the apps and the folders). */
const scrollBoard = (to: 'top' | 'end') =>
  page.evaluate((t) => {
    const w = document.querySelector('.board-wrap')!;
    w.scrollTop = t === 'top' ? 0 : w.scrollHeight;
  }, to);

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
  const email = `access-${Date.now()}@example.com`;
  const password = 'a long test password';
  const env = { ...stackEnv(), EDGE_URL_ACCOUNTS: stackService('accounts'), EDGE_URL_BOARD: stackService('board') };
  const made = await (await clientFromEnv('edge', 'accounts', env))(ACCOUNTS.signup, { body: { email, password } });
  await (await clientFromEnv('edge', 'board', env))(BOARD.createDefaults, { params: { account_id: made.account.account_id }, body: { category: 'sports' } });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'light' });
  page = await ctx.newPage();
  blank = await ctx.newPage(); // about:blank has no CSP: the screenshots are decoded here
  await page.bringToFront();
  await page.goto(WEB_URL + '/');
  // Log in rather than sign up, as speed.test.ts does: the web files share edge's small sign-up budget.
  await page.getByRole('tab', { name: 'Log in' }).tap();
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Log in' }).last().tap();
  await onBoard(page);
  await page.waitForTimeout(3000); // the boot animations end
  // No transitions while the test changes the look in place: a color in mid-fade is not the color it settles on.
  await page.evaluate(() => {
    const s = new CSSStyleSheet();
    s.replaceSync('*, *::before, *::after { transition: none !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
  });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('Access on a phone: every theme, mode and hue', () => {
  it('contrast at least 4.5:1, targets at least 44 px, text sizes, never red for down: first board and the Look sheet', async () => {
    const bad: string[] = [];
    const under16 = new Map<string, Set<string>>();
    for (const surface of ['board', 'low', 'look'] as const) {
      await scrollBoard(surface === 'low' ? 'end' : 'top');
      if (surface === 'look') await openLook();
      for (const t of THEMES)
        for (const mode of MODES)
          for (const hue of surface === 'low' ? [null] : HUES) {
            await setLook(page, t.id, mode, hue);
            await checkState(page, blank, `${surface} ${t.id} ${mode} ${hue ?? 'own hue'}`, bad, under16);
            if (SHOTS && hue == null) await page.screenshot({ path: join(SHOTS, `${t.id}-${mode}-${surface}.png`), animations: 'allow' });
          }
      if (surface === 'look') await closeLook();
    }
    if (SHOTS) writeFileSync(join(SHOTS, 'access-under-16.json'), JSON.stringify(Object.fromEntries([...under16].map(([k, v]) => [k, [...v].slice(0, 6)])), null, 1));
    expect(uniq(bad)).toEqual([]);
  }, 420_000);

  it('a tap at the centre of every app and folder tile opens it, and a tap on its visible ⋯ opens the menu', async () => {
    await page.locator('#look-btn').waitFor();
    const open = () => page.evaluate(() => [...document.querySelectorAll('.surface')].filter((s) => !s.classList.contains('is-closing')).map((s) => s.className));
    const closeAll = async () => {
      await page.keyboard.press('Escape');
      await expect.poll(open, { timeout: 8000 }).toEqual([]);
    };
    const tapCentre = async (sel: string) => {
      const el = page.locator(sel);
      await el.scrollIntoViewIfNeeded();
      const b = (await el.boundingBox())!;
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    };
    const ids = await page.locator('#board > .w--app, #board > .w--folder').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id!));
    expect(ids.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const id of ids) {
      const tile = `#board > .w[data-id="${id}"]`;
      // Twice: the tap is pulled towards a nearby button only some of the time when it is borderline.
      for (let i = 0; i < 2; i++) {
        await tapCentre(`${tile} > :is(.a-tile, .f-tile)`);
        await expect.poll(async () => (await open()).length, { timeout: 8000 }).toBeGreaterThan(0);
        const got = await open();
        if (got.some((c) => /\bmenu\b/.test(c)) || !got.some((c) => /\b(sheet|folder-open)\b/.test(c))) bad.push(`${id}: a tap at the centre opened ${got.join(' | ')}`);
        await closeAll();
      }
      await tapCentre(`${tile} .w-menu-btn`);
      await expect.poll(async () => (await open()).length, { timeout: 8000 }).toBeGreaterThan(0);
      const menu = await open();
      if (!menu.some((c) => /\bmenu\b/.test(c))) bad.push(`${id}: a tap on the ⋯ opened ${menu.join(' | ')}`);
      await closeAll();
    }
    expect(bad).toEqual([]);
  });

  it('with reduced transparency (solid glass) the contrast holds', async () => {
    const bad: string[] = [];
    const under16 = new Map<string, Set<string>>();
    await setLook(page, THEMES[0]!.id, 'light', null, 'reduced');
    for (const surface of ['board', 'low', 'look'] as const) {
      await scrollBoard(surface === 'low' ? 'end' : 'top');
      if (surface === 'look') await openLook();
      for (const t of THEMES.filter((x) => ['agent-mail', 'stadium-night', 'ice'].includes(x.id)))
        for (const mode of MODES)
          for (const hue of [null, 95] as const) {
            await setLook(page, t.id, mode, hue, 'reduced');
            await checkState(page, blank, `solid ${surface} ${t.id} ${mode} ${hue ?? 'own hue'}`, bad, under16);
            if (SHOTS && hue == null) await page.screenshot({ path: join(SHOTS, `solid-${t.id}-${mode}-${surface}.png`), animations: 'allow' });
          }
      if (surface === 'look') await closeLook();
    }
    await setLook(page, THEMES[0]!.id, 'light', null, 'full');
    expect(uniq(bad)).toEqual([]);
  });

  it('with reduced motion the wallpaper stops and only fades run, in every theme and mode', async () => {
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce', storageState: await ctx.storageState() })).newPage();
    await p.goto(WEB_URL + '/');
    await onBoard(p);
    await p.waitForTimeout(1200);
    expect(await p.evaluate(() => document.documentElement.dataset.motion)).toBe('reduced');
    const FADES = new Set(['opacity', 'background-color', 'backgroundColor', 'color']);
    const census = () =>
      p.evaluate(() =>
        document.getAnimations().flatMap((a) => {
          const ef = a.effect as KeyframeEffect | null;
          if (a.playState !== 'running' || !ef) return [];
          const props = ef.getKeyframes().flatMap((k) => Object.keys(k).filter((x) => !['offset', 'computedOffset', 'easing', 'composite'].includes(x)));
          return [{ who: `${(ef.target as Element | null)?.tagName}.${(ef.target as Element | null)?.className}${ef.pseudoElement ?? ''}`, props, iterations: ef.getComputedTiming().iterations }];
        }),
      );
    const bad: string[] = [];
    for (const t of THEMES)
      for (const mode of MODES) {
        await p.evaluate(([id, m]) => {
          document.documentElement.dataset.theme = id;
          document.documentElement.dataset.mode = m;
        }, [t.id, mode] as const);
        await p.waitForTimeout(250);
        for (const a of await census()) {
          if (a.iterations === Infinity) bad.push(`${t.id} ${mode}: forever ${a.who}: ${a.props.join(', ')}`);
          const off = a.props.filter((x) => !FADES.has(x));
          if (off.length) bad.push(`${t.id} ${mode}: ${a.who} animates ${off.join(', ')}`);
        }
      }
    // A sheet opening is a fade too.
    await p.locator('#look-btn').click();
    for (const a of await census()) {
      const off = a.props.filter((x) => !FADES.has(x));
      if (off.length) bad.push(`sheet: ${a.who} animates ${off.join(', ')}`);
    }
    await p.context().close();
    expect(uniq(bad)).toEqual([]);
  });
});
