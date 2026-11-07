/**
 * The web app in a real browser, through Caddy and edge, on the local stack (web/dev/stack.sh up; `make web-e2e`
 * does it all). A guest signs up and sees the default board with first-paint numbers, in two themes, light and dark.
 * A drag saves and survives a reload; the look saves and survives a reload; /live carries look.changed; a logout
 * elsewhere closes the socket with 4001 and the page goes back to the door. No console error (a policy violation
 * is one), and no request leaves the origin.
 *
 *   WEB_URL (default http://localhost:8490)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR (default web/test/.shots)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHtml } from '../build.ts';

const URL0 = process.env.WEB_URL ?? 'http://localhost:8490';
const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });

let browser: Browser;
const problems: string[] = [];
/** The first guest's session, reused so the run stays under edge's guest limit (5 an hour per address). */
let session: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;

/** A page that records console errors, page errors and any request off the origin. */
async function open(ctx: BrowserContext, path = '/'): Promise<Page> {
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(URL0) && !u.startsWith(URL0.replace('http', 'ws')) && !u.startsWith('data:')) problems.push(`off-origin request: ${u}`);
  });
  await page.goto(URL0 + path);
  return page;
}

const ready = (page: Page) => page.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });

/** The grid order as the user sees it: tiles sorted by their position. */
const visualOrder = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('#board > .w'))
      .filter((w) => !w.classList.contains('is-out'))
      .map((w) => {
        const r = w.getBoundingClientRect();
        return { id: w.dataset.id!, x: Math.round(r.left), y: Math.round(r.top) };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((t) => t.id),
  );

const tileText = (page: Page, title: string) => page.locator(`#board > .w[aria-label="${title}"]`).innerText();

async function guest(ctx: BrowserContext) {
  const page = await open(ctx);
  await page.getByRole('button', { name: 'Try it as a guest' }).click();
  await ready(page);
  return page;
}

async function setLookInSheet(page: Page, themeName: string, mode: 'Light' | 'Dark' | 'System') {
  await page.locator('#look-btn').click();
  const sheet = page.locator('.surface.sheet');
  await sheet.locator('.theme-chip', { hasText: themeName }).click();
  const save = page.waitForResponse((r) => r.url().endsWith('/api/look') && r.request().method() === 'PUT');
  await sheet.locator(`[data-mode-set]`, { hasText: mode }).click();
  expect((await save).status()).toBe(200);
  await page.keyboard.press('Escape');
}

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('web app on the local stack', () => {
  it('serves a page the policy allows: no inline script or style, the CSP header set', async () => {
    const res = await fetch(URL0 + '/');
    expect(res.status).toBe(200);
    expect(checkHtml(await res.text())).toEqual([]);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
  });

  for (const [theme, name, mode] of [
    ['agent-mail', 'Agent Mail', 'light'],
    ['ice', 'Ice', 'dark'],
  ] as const) {
    it(`a guest sees the default board with first-paint numbers (${name}, ${mode})`, async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: mode });
      const page = await guest(ctx);
      // The default board: 6 displays, 2 folders, 5 apps on the grid.
      expect(await page.locator('#board > .w--display').count()).toBe(6);
      expect(await page.locator('#board > .w--folder').count()).toBe(2);
      expect(await page.locator('#board > .w--app').count()).toBe(5);
      // First paint: cached exchange prices from markets, with their time.
      const tonight = await tileText(page, 'Tonight');
      expect(tonight).toMatch(/\d+%/);
      expect(tonight).toMatch(/as of/);
      const market = await tileText(page, 'Chiefs beat the Bills');
      expect(market).toMatch(/Kalshi \d+¢/);
      expect(market).toMatch(/Polymarket \d+¢/);
      expect(await tileText(page, 'Gap')).toMatch(/pts? apart/);
      expect(await tileText(page, 'NFL Week 10')).toMatch(/\d+\s*%/);
      expect(await page.locator('.foot').innerText()).toContain('Not investment advice.');

      await setLookInSheet(page, name, mode === 'dark' ? 'Dark' : 'Light');
      await page.waitForTimeout(1200);
      expect(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode])).toEqual([theme, mode]);
      await page.screenshot({ path: join(SHOTS, `desktop-${theme}-${mode}.png`) });

      // The look survives a reload: it came back from accounts.
      await page.reload();
      await ready(page);
      expect(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode])).toEqual([theme, mode]);

      // The surfaces: the ⋯ menu, an open folder, the Look sheet.
      await page.locator('#board > .w[aria-label="Chiefs beat the Bills"] .w-menu-btn').click();
      await page.waitForTimeout(1300);
      await expect(page.locator('.surface.menu').innerText()).resolves.toContain('next build');
      await page.screenshot({ path: join(SHOTS, `menu-${theme}-${mode}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.locator('#board > .w[aria-label="NFL Week 10"]').click();
      await page.waitForTimeout(1300);
      expect(await page.locator('.surface.folder-open .card').count()).toBe(4);
      await page.screenshot({ path: join(SHOTS, `folder-${theme}-${mode}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.locator('#look-btn').click();
      await page.waitForTimeout(1300);
      await page.screenshot({ path: join(SHOTS, `look-${theme}-${mode}.png`) });
      session ??= await ctx.storageState();
      await ctx.close();
    });
  }

  it('a drag saves the layout, and it survives a reload', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: session });
    const page = await open(ctx);
    await ready(page);
    const before = await visualOrder(page);
    const gap = page.locator('#board > .w[aria-label="Gap"]');
    const tonight = page.locator('#board > .w[aria-label="Tonight"]');
    const a = (await gap.boundingBox())!;
    const b = (await tonight.boundingBox())!;
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/board/layout') && r.request().method() === 'PUT');
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 });
    await page.mouse.move(b.x + b.width / 3, b.y + b.height / 3, { steps: 30 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(SHOTS, 'mid-drag.png') });
    await page.waitForTimeout(400);
    await page.mouse.up();
    expect((await saved).status()).toBe(200);
    await page.waitForTimeout(1200);
    const after = await visualOrder(page);
    // Under load the swaps it passes over can differ; what matters: the order changed, it was saved, a reload keeps it.
    expect(after).not.toEqual(before);
    await page.reload();
    await ready(page);
    expect(await visualOrder(page)).toEqual(after);
    await ctx.close();
  });

  it('on a phone: 4 columns, the chat pill, the board scrolls', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', storageState: session });
    const page = await open(ctx);
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.dataset.layout)).toBe('phone');
    await page.screenshot({ path: join(SHOTS, 'phone-agent-mail-dark.png') });
    await ctx.close();
  });

  it('/live: look.changed from another tab applies here; a logout closes the socket (4001) and the page returns to the door', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', storageState: session });
    const page = await open(ctx);
    await ready(page);
    const other = await open(ctx);
    await ready(other);
    // The other tab saves a look through edge; accounts emits look.changed; edge pushes it to this tab.
    expect(await other.evaluate(() => fetch('/api/look', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: 'mercury', mode: 'dark', hue: 200 }) }).then((r) => r.status))).toBe(200);
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'mercury' && document.documentElement.dataset.mode === 'dark', null, { timeout: 15_000 });
    // Logout in the other tab: edge closes this tab's socket with 4001; /api/me answers 401; the door comes back.
    expect(await other.evaluate(() => fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status))).toBe(200);
    await page.waitForFunction(() => document.documentElement.dataset.view === 'auth', null, { timeout: 20_000 });
    await page.getByRole('button', { name: 'Try it as a guest' }).waitFor();
    await page.screenshot({ path: join(SHOTS, 'door-after-logout.png') });
    await ctx.close();
  });

  it('a 413 from the door shows a notice instead of failing silently', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await open(ctx);
    await page.getByRole('button', { name: 'Try it as a guest' }).waitFor();
    await page.getByRole('tab', { name: 'Log in' }).click();
    await page.locator('input[name="email"]').fill('big@example.com');
    // Past the 64 KB body cap: the input's maxlength is lifted for this test only.
    await page.evaluate(() => document.querySelector<HTMLInputElement>('input[name="password"]')!.removeAttribute('maxlength'));
    await page.locator('input[name="password"]').fill('x'.repeat(70_000));
    await page.getByRole('button', { name: 'Log in' }).last().click();
    await expect.poll(() => page.locator('#auth-err').innerText(), { timeout: 10_000 }).toContain('too large');
    await ctx.close();
  });

  it('had no console errors, no policy violations and no off-origin requests', () => {
    // A 401 from /api/me at the door and the 413 above are expected network answers; Chromium logs failed loads as errors.
    const real = problems.filter((p) => !/Failed to load resource: the server responded with a status of (401|413)/.test(p));
    expect(real).toEqual([]);
  });
});
