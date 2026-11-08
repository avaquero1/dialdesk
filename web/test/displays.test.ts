/**
 * W1.2.1 in a real browser at phone size, on the local stack (web/dev/stack.sh up; `make web-e2e`), in two themes, light
 * and dark. A new user signs up by email; the test plays the runner: one batched numbers run for the first board's
 * displays (runner's plans on markets' fake through the real engine: display-results.ts), put to board. Each display
 * then shows its numbers in plain words; a down move isn't red; a refresh that joins this minute's run says "Updated
 * just now"; an open folder refreshes its cards; How we got this hides the batch prefixes; no grey bar over the board.
 *
 *   WEB_URL (default: this worktree's stack, web/test/stack.ts)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR (default web/test/.shots)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD, type Widget } from '@app/contracts';
import { clientFromEnv } from '@app/service-kit';
import { numbersRun, type Made } from './display-results.ts';
import { WEB_URL, stackEnv } from './stack.ts';

const URL0 = WEB_URL;
const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });

let browser: Browser;
const ready = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (p: Page) =>
  p.waitForFunction(() => !document.querySelector('.surface.is-closing, #board > .w.is-new') && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'), null, {
    timeout: 30_000,
    polling: 100,
  });

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('W1.2.1: the displays at phone size', () => {
  for (const [theme, name, mode] of [
    ['agent-mail', 'Agent Mail', 'light'],
    ['ice', 'Ice', 'dark'],
  ] as const) {
    it(`each display shows its numbers in plain words; a down move isn't red; a joined refresh says "Updated just now" (${name}, ${mode})`, async () => {
      const problems: string[] = [];
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: mode });
      const page = await ctx.newPage();
      page.on('console', (m) => {
        const expected = /Failed to load resource/.test(m.text()) && /\b401\b/.test(m.text()) && m.location().url.endsWith('/api/me');
        if (m.type() === 'error' && !expected) problems.push(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      const refreshes: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().endsWith('/refresh')) refreshes.push(decodeURIComponent(r.url().split('/api/widgets/')[1]!.split('/')[0]!));
      });
      const shot = (n: string) => page.screenshot({ path: join(SHOTS, `w1-2-1-${theme}-${mode}-${n}.png`) });

      await page.goto(URL0 + '/');
      await page.locator('input[name="email"]').fill(`displays-${theme}-${Date.now()}@example.com`);
      await page.locator('input[name="password"]').fill('a long test password');
      await page.getByRole('button', { name: 'Create my board' }).tap();
      await ready(page);
      await page.locator('#look-btn').click();
      const look = page.locator('.surface.sheet');
      await look.locator('.theme-chip', { hasText: name }).click();
      const save = page.waitForResponse((r) => r.url().endsWith('/api/look') && r.request().method() === 'PUT');
      await look.locator('[data-mode-set]', { hasText: mode === 'dark' ? 'Dark' : 'Light' }).click();
      expect((await save).status()).toBe(200);
      await page.keyboard.press('Escape');
      await settled(page);

      // The runner's part: one batched numbers run for the board's displays, put to board.
      const { me, b } = await page.evaluate(async () => ({
        me: (await (await fetch('/api/me')).json()) as { account_id: string },
        b: (await (await fetch('/api/board')).json()) as { widgets: Widget[] },
      }));
      const specs = b.widgets.map((w) => w.spec).filter((s): s is Made['spec'] => s.kind === 'display' && s.type !== 'news' && s.type !== 'positions');
      const made = await numbersRun(specs, me.account_id);
      const board = await clientFromEnv('runner', 'board', stackEnv());
      for (const m of made) await board(BOARD.putResult, { params: { widget_id: m.spec.widget_id }, body: m.body });

      const grid = made.filter((m) => !('folder_id' in m.spec.place));
      const tile = (m: Made) => page.locator(`#board > .w[data-id="${m.spec.widget_id}"]`);
      const of = (t: string) => grid.find((m) => m.spec.type === t)!;
      const market = grid.find((m) => m.spec.type === 'probability')!;
      const ip = market.body.result.numbers.find((n) => n.op === 'implied_probability')!;
      // The result's numbers reach the screen: the Market's chance from the engine and its base rate in words.
      // The result has landed when the Market shows its base rate (first paint has none).
      await expect.poll(() => tile(market).innerText(), { timeout: 30_000 }).toMatch(/Home teams won \d+% of \d+ (NFL|NBA) games on Kalshi this season\./);
      expect(await tile(market).innerText()).toMatch(new RegExp(`${Math.round(ip.value * 100)}%\\s*chance`));
      await settled(page);

      const marketText = await tile(market).innerText();
      expect(marketText).toMatch(/(Up|Down) \d+ points? since yesterday|No change since yesterday/);
      expect(marketText).toMatch(/Home teams won \d+% of \d+ (NFL|NBA) games on Kalshi this season\./);
      expect(marketText).toContain('for a YES that pays $1');
      expect(marketText).toContain('7 days');
      const tonight = await tile(of('events')).innerText();
      expect(tonight).toMatch(/[▲▼—]\s+(up \d+|down \d+|no change)/);
      const gap = of('gap');
      expect(await page.locator(`#board > .w[aria-label="Two prices"]`).count()).toBe(1);
      expect(await tile(gap).innerText()).toMatch(/\d+\s+points? apart|The same price on both|Not compared/);
      const big = of('movement');
      expect(await tile(big).innerText()).toMatch(/Biggest move[\s\S]*\bat\b[\s\S]*%\s*chance/);
      for (const m of grid) {
        const t = await tile(m).innerText();
        expect(t, m.spec.title).not.toMatch(/\bpts?\b|implied/i);
      }
      await shot('board');
      await tile(big).scrollIntoViewIfNeeded();
      await settled(page);
      await shot('board-lower');

      // A down move is an arrow and words in the text color, never red (red is for a blocked trick or a real error).
      const colors = await page.evaluate(() => {
        const host = document.querySelector('#board > .w--display .w-in')!;
        const probe = (cls: string) => {
          const s = document.createElement('span');
          s.className = cls;
          host.append(s);
          const c = getComputedStyle(s).color;
          s.remove();
          return c;
        };
        return { down: probe('mv mv--down'), up: probe('mv mv--up') };
      });
      expect(colors.down).toBe(colors.up);
      const [r, g, bl] = colors.down.match(/[\d.]+/g)!.map(Number);
      expect(r! - Math.max(g!, bl!), `down color ${colors.down}`).toBeLessThan(40);

      // No grey bar over the board: the closed chat sheet's handle isn't drawn.
      expect(await page.locator('.chat-handle').evaluate((e) => getComputedStyle(e).visibility)).toBe('hidden');

      // Refresh now twice in the same minute: the second joins the first's run and says so.
      const t0 = of('events');
      const menuRow = (label: string) => page.locator('.surface.menu.is-open .m-main .mi', { hasText: label });
      for (const n of [1, 2]) {
        await tile(t0).locator('.w-menu-btn').tap();
        await page.locator('.surface.menu.is-open').waitFor();
        await settled(page);
        const res = page.waitForResponse((x) => x.url().endsWith('/refresh') && x.request().method() === 'POST');
        await menuRow('Refresh now').tap();
        const body = (await (await res).json()) as { joined?: boolean };
        // The first may already join a run of this minute (the sign-up's); the second always does.
        if (n === 2) expect(body.joined, 'the second refresh joins').toBe(true);
      }
      await expect.poll(() => tile(t0).innerText(), { timeout: 5000 }).toContain('Updated just now');
      await expect.poll(() => page.locator('#toast').innerText(), { timeout: 5000 }).toMatch(/updated just now/);
      await tile(t0).scrollIntoViewIfNeeded();
      await shot('updated-just-now');

      // Opening a folder refreshes its cards.
      const folder = b.widgets.find((w) => w.spec.kind === 'folder')!;
      const kids = b.widgets.filter((w) => 'folder_id' in w.spec.place && w.spec.place.folder_id === folder.spec.widget_id && w.spec.kind === 'display').map((w) => w.spec.widget_id);
      expect(kids.length).toBeGreaterThan(0);
      const before = refreshes.length;
      // In the middle of the screen, clear of the chat pill at the bottom.
      await page.locator(`#board > .w[data-id="${folder.spec.widget_id}"]`).evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await settled(page);
      await shot('before-folder');
      await page.locator(`#board > .w[data-id="${folder.spec.widget_id}"]`).tap();
      await page.locator('.surface.folder-open.is-open').waitFor();
      await expect.poll(() => refreshes.length - before, { timeout: 10_000 }).toBe(kids.length);
      expect(new Set(refreshes.slice(before))).toEqual(new Set(kids));
      await settled(page);
      const folderText = await page.locator('.surface.folder-open').innerText();
      expect(folderText).not.toMatch(/implied|\bpts?\b/i);
      await shot('folder');
      await page.keyboard.press('Escape');
      await settled(page);

      // How we got this: the receipts' op ids without the batch's b<i>_ prefix.
      await tile(market).scrollIntoViewIfNeeded();
      await tile(market).locator('.w-menu-btn').tap();
      await page.locator('.surface.menu.is-open').waitFor();
      await settled(page);
      await menuRow('How we got this').tap();
      const how = page.locator('.surface.sheet.is-open');
      await how.waitFor();
      await settled(page);
      expect(await how.innerText()).toContain('The price on a day of the line');
      await how.locator('#how-toggle').scrollIntoViewIfNeeded();
      await how.locator('#how-toggle').tap();
      await expect.poll(() => how.locator('#how-details').isVisible()).toBe(true);
      const det = await how.locator('#how-details').innerText();
      expect(det).toMatch(/\(n\d+\)/);
      expect(det).not.toMatch(/\bb\d+_/);
      await shot('how-details');
      await page.keyboard.press('Escape');

      expect(problems).toEqual([]);
      await ctx.close();
    });
  }
});
