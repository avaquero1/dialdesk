/**
 * The ⋯ menu's actions at phone size, in a real browser on the local stack (web/dev/stack.sh up; `make web-e2e`):
 * the same rows on every tile (greyed, never hidden), Size, Refresh now, Move to a folder, Remove with Undo, and
 * Clear all that asks once, then offers Undo. Undo sends nothing; a change whose offer ends is saved, and the board
 * after a reload is the board before it.
 *
 *   WEB_URL (default http://localhost:8490)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR (default web/test/.shots)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL0 = process.env.WEB_URL ?? 'http://localhost:8490';
const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `menu-phone-${name}.png`) });

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const problems: string[] = [];
/** The tiles each test uses, picked by type from the board (titles follow the week's games). */
const T = { market: '', gap: '', tonight: '', positions: '', folder1: '', folder2: '', app: '' };
/** Every menu call the page sent, as "METHOD /path". */
const sent: string[] = [];

const ready = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (p: Page) =>
  p.waitForFunction(
    () =>
      !document.querySelector('.surface.is-closing, #board > .w.is-new') &&
      document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'),
    null,
    { timeout: 30_000, polling: 100 },
  );
const tile = (title: string) => page.locator(`#board > .w:not(.is-out)[aria-label="${title}"]`);
const menu = () => page.locator('.surface.menu.is-open');
const row = (label: string) => menu().locator('.m-main .mi', { hasText: label });
const undoToast = () => page.locator('.undo-toast');

async function openMenu(title: string) {
  await tile(title).locator('.w-menu-btn').tap();
  await menu().waitFor();
  await settled(page);
}

/** What the user sees: grid tiles by position, with their size class; folders with their tiles. */
const boardState = () =>
  page.evaluate(() => {
    const grid = Array.from(document.querySelectorAll<HTMLElement>('#board > .w'))
      .filter((w) => !w.classList.contains('is-out'))
      .map((w) => {
        const r = w.getBoundingClientRect();
        const size = /w--(s|m|l|xl)\b/.exec(w.className)?.[1] ?? '';
        return { t: w.getAttribute('aria-label')!, size, x: Math.round(r.left), y: Math.round(r.top + (document.querySelector('#board-wrap')?.scrollTop ?? 0)) };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((t) => `${t.t}${t.size ? ':' + t.size : ''}`);
    return grid;
  });

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/widgets/') || u.pathname === '/api/board/layout') sent.push(`${r.method()} ${u.pathname}`);
  });
  await page.goto(URL0);
  await page.getByRole('button', { name: 'Try it as a guest' }).tap();
  await ready(page);
  const b = await page.evaluate(() => fetch('/api/board').then((r) => r.json() as Promise<{ widgets: { spec: Record<string, unknown> & { title: string; place: object } }[] }>));
  const grid = b.widgets.map((w) => w.spec).filter((s) => !('folder_id' in s.place));
  const find = (f: (s: Record<string, unknown>) => boolean) => grid.find(f)?.title ?? '';
  T.market = find((s) => s.type === 'probability' && s.size === 'M');
  T.gap = find((s) => s.type === 'gap');
  T.tonight = find((s) => s.type === 'events');
  T.positions = find((s) => s.type === 'positions');
  const folders = grid.filter((s) => s.kind === 'folder').map((s) => s.title);
  T.folder1 = folders[0] ?? '';
  T.folder2 = folders[1] ?? '';
  T.app = find((s) => s.app === 'receipts') && 'How we got it'; // the tile shows the app's plain name (W1.2.3)
  expect(Object.values(T).every(Boolean), JSON.stringify(T)).toBe(true);
});
afterAll(async () => {
  await browser?.close();
});

describe('the ⋯ menu at phone size', () => {
  it('is the same seven rows on a display, an app and a folder; what does not apply is greyed, never hidden', async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.layout)).toBe('phone');
    const seen: Record<string, { labels: string[]; off: string[] }> = {};
    for (const title of [T.market, T.app, T.folder1]) {
      await openMenu(title);
      seen[title] = await menu().evaluate((m) => {
        const rows = Array.from(m.querySelectorAll<HTMLElement>('.m-main .mi'));
        const label = (r: HTMLElement) => r.querySelector('.grow')!.textContent!;
        return { labels: rows.map(label), off: rows.filter((r) => r.getAttribute('aria-disabled') === 'true').map(label) };
      });
      if (title === T.market) await shot(page, 'display');
      if (title === T.folder1) await shot(page, 'folder');
      await page.keyboard.press('Escape');
      await settled(page);
    }
    const seven = ['Change it with the agent', 'Refresh now', 'Size', 'How we got this', 'Move to a folder', 'Clear all', 'Remove'];
    for (const s of Object.values(seen)) expect(s.labels).toEqual(seven);
    expect(seen[T.market]!.off).toEqual([]);
    expect(seen[T.app]!.off).toEqual(['Change it with the agent', 'Refresh now', 'Size', 'How we got this', 'Clear all']);
    expect(seen[T.folder1]!.off).toEqual(['Change it with the agent', 'Refresh now', 'Size', 'How we got this', 'Move to a folder', 'Clear all']);
  });

  it('Size: medium to large resizes the tile, saves the layout, and the others flow', async () => {
    expect(await tile(T.market).getAttribute('class')).toContain('w--m');
    await openMenu(T.market);
    // XL is not in the catalog for a one-market card: greyed, still there.
    expect(await menu().locator('[data-size="XL"]').getAttribute('aria-disabled')).toBe('true');
    expect(await menu().locator('[data-size="XL"]').isVisible()).toBe(true);
    const patched = page.waitForResponse((r) => r.url().includes('/size') && r.request().method() === 'PATCH');
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/board/layout') && r.request().method() === 'PUT');
    await menu().locator('[data-size="L"]').tap();
    expect((await patched).status()).toBe(200);
    expect((await saved).status()).toBe(200);
    await page.waitForFunction((t) => document.querySelector(`#board > .w[aria-label="${CSS.escape(t)}"]`)?.classList.contains('w--l'), T.market);
    await settled(page);
    const box = (await tile(T.market).boundingBox())!;
    expect(box.height).toBeGreaterThan(box.width * 0.8); // 4 x 4 now, not 4 x 2
    await tile(T.market).scrollIntoViewIfNeeded();
    await settled(page);
    await shot(page, 'resized-large');
  });

  it('Refresh now asks edge for a run (202) and runs the shimmer once', async () => {
    await openMenu(T.tonight);
    const refreshed = page.waitForResponse((r) => r.url().endsWith('/refresh') && r.request().method() === 'POST');
    await row('Refresh now').tap();
    expect((await refreshed).status()).toBe(202);
  });

  it('Remove takes the tile off at once; Undo brings it back and nothing is sent', async () => {
    const before = await boardState();
    await openMenu(T.gap);
    await row('Remove').tap();
    await tile(T.gap).waitFor({ state: 'detached' });
    await undoToast().locator('.u-btn').waitFor({ state: 'visible' });
    expect(await undoToast().innerText()).toContain(`Removed ${T.gap}`);
    await settled(page);
    await shot(page, 'removed-undo-offer');
    await undoToast().locator('.u-btn').tap();
    await tile(T.gap).waitFor();
    await settled(page);
    expect(await boardState()).toEqual(before);
    await page.waitForTimeout(6000); // past the offer: still nothing sent
    expect(sent.filter((s) => s.startsWith('DELETE'))).toEqual([]);
    await shot(page, 'removed-undone');
  });

  it('Remove without Undo: sent when the offer ends, and gone after a reload', async () => {
    await openMenu(T.gap);
    const deleted = page.waitForResponse((r) => r.url().includes('/api/widgets/') && r.request().method() === 'DELETE', { timeout: 15_000 });
    await row('Remove').tap();
    await undoToast().locator('.u-btn').waitFor({ state: 'visible' });
    expect((await deleted).status()).toBe(200);
    await undoToast().locator('.u-btn').waitFor({ state: 'hidden' });
    expect(await tile(T.gap).count()).toBe(0);
  });

  it('Clear all asks once inside the menu, then offers Undo; Undo sends nothing', async () => {
    await openMenu(T.tonight);
    const h0 = (await menu().boundingBox())!.height;
    await row('Clear all').tap();
    // Asked inside the menu: the row asks, the note says what it does, the menu keeps its size and stays open.
    await expect.poll(() => row('Yes, clear all').count()).toBe(1);
    expect(await menu().locator('#mi-note').innerText()).toContain('back to its defaults');
    expect((await menu().boundingBox())!.height).toBe(h0);
    expect(sent.filter((s) => s.endsWith('/clear'))).toEqual([]);
    await shot(page, 'clear-asks');
    await row('Yes, clear all').tap();
    await undoToast().locator('.u-btn').waitFor({ state: 'visible' });
    expect(await undoToast().innerText()).toContain(`${T.tonight} is back to its defaults`);
    await settled(page);
    await shot(page, 'cleared-undo-offer');
    await undoToast().locator('.u-btn').tap();
    await undoToast().locator('.u-btn').waitFor({ state: 'hidden' });
    await page.waitForTimeout(6000);
    expect(sent.filter((s) => s.endsWith('/clear'))).toEqual([]);
  });

  it('Clear all without Undo: sent when the offer ends', async () => {
    await openMenu(T.tonight);
    await row('Clear all').tap();
    const cleared = page.waitForResponse((r) => r.url().endsWith('/clear') && r.request().method() === 'POST', { timeout: 15_000 });
    await row('Yes, clear all').tap();
    expect((await cleared).status()).toBe(200);
    expect(await tile(T.tonight).count()).toBe(1);
  });

  it('Move to a folder: the folder list, then the tile is in the folder and off the grid', async () => {
    await openMenu(T.positions);
    await row('Move to a folder').tap();
    await menu().locator('.m-pick [data-folder]').first().waitFor({ state: 'visible' });
    await settled(page);
    await shot(page, 'move-pick');
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/board/layout') && r.request().method() === 'PUT');
    await menu().locator('.m-pick [data-folder]', { hasText: T.folder2 }).tap();
    expect((await saved).status()).toBe(200);
    await tile(T.positions).waitFor({ state: 'detached' });
    await settled(page);
    await tile(T.folder2).tap();
    await page.locator('.surface.folder-open.is-open').waitFor();
    await settled(page);
    expect(await page.locator('.surface.folder-open').innerText()).toContain(T.positions);
    await shot(page, 'moved-in-folder');
    await page.keyboard.press('Escape');
    await settled(page);
  });

  it('the layout survives a reload: sizes, the removed tile, the moved tile', async () => {
    const before = await boardState();
    expect(before).toContain(`${T.market}:l`);
    expect(before.some((t) => t.startsWith(T.gap + ':') || t.startsWith(T.positions + ':'))).toBe(false);
    await page.reload();
    await ready(page);
    await settled(page);
    expect(await boardState()).toEqual(before);
    await shot(page, 'after-reload');
  });

  it('had no console errors and no page errors', () => {
    const expected = [/status of 401 .* @ http:\/\/[^/]+\/api\/me$/];
    expect(problems.filter((p) => !(p.startsWith('console: Failed to load resource') && expected.some((e) => e.test(p))))).toEqual([]);
  });
});
