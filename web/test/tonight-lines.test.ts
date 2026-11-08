/**
 * W1.2.7 in a real browser at phone size, on the local stack (web/dev/stack.sh up; `make web-e2e`), light and dark. A new
 * user signs up by email; the test plays the runner: one batched numbers run for the first board's displays (runner's
 * plans on markets' fake through the real engine: display-results.ts), put to board. Each of Tonight's rows then shows
 * its game's small 7-day line from the engine's price_at numbers: under the name on the large card (also with 6 games),
 * beside it on a medium one, which still fits. Drawn once: nothing in the rows moves at rest.
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

const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });

let browser: Browser;
let signedUpAt = 0;
const ready = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (p: Page) =>
  p.waitForFunction(() => !document.querySelector('.surface.is-closing, #board > .w.is-new') && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'), null, {
    timeout: 30_000,
    polling: 100,
  });

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
});
// The web files share one address and edge allows 5 sign-ups, then one per 2 minutes: this file's one sign-up is given
// back before the next file starts, so it leaves the others the budget they had.
afterAll(async () => {
  await browser?.close();
  if (signedUpAt) await new Promise((r) => setTimeout(r, Math.max(0, signedUpAt + 125_000 - Date.now())));
}, 180_000);

/** Each Tonight row's line: its points, its box and its size, and whether anything inside the rows animates. */
const rowsOf = (p: Page, id: string) =>
  p.evaluate((id) => {
    const tile = document.querySelector(`#board > .w[data-id="${id}"]`)!;
    const card = tile.getBoundingClientRect();
    const rows = [...tile.querySelectorAll('.game')].map((g) => {
      const s = g.querySelector('.g-s')!;
      const ln = s.querySelector('polyline.ln');
      const r = s.getBoundingClientRect();
      const row = g.getBoundingClientRect();
      return {
        name: g.querySelector('.g-n')!.textContent,
        points: ln ? ln.getAttribute('points')!.trim().split(/\s+/).length : 0,
        shown: getComputedStyle(s).display !== 'none' && r.width > 0 && r.height > 0,
        w: r.width,
        h: r.height,
        inside: row.top >= card.top - 0.5 && row.bottom <= card.bottom + 0.5,
      };
    });
    const moving = [...tile.querySelectorAll('.games *')].flatMap((e) => e.getAnimations());
    return { rows, moving: moving.length, height: card.height };
  }, id);

describe('W1.2.7: Tonight’s small lines at phone size', () => {
  it('each Tonight row shows its game’s 7-day line, on the large card and the medium one (Agent Mail light, Ice dark)', async () => {
    const problems: string[] = [];
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      const expected = /Failed to load resource/.test(m.text()) && /\b401\b/.test(m.text()) && m.location().url.endsWith('/api/me');
      if (m.type() === 'error' && !expected) problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

    await page.goto(WEB_URL + '/');
    await page.locator('input[name="email"]').fill(`tonight-${Date.now()}@example.com`);
    await page.locator('input[name="password"]').fill('a long test password');
    signedUpAt = Date.now();
    await page.getByRole('button', { name: 'Create my board' }).tap();
    await ready(page);

    // The runner's part: one batched numbers run for the board's displays, put to board.
    const { me, b } = await page.evaluate(async () => ({
      me: (await (await fetch('/api/me')).json()) as { account_id: string },
      b: (await (await fetch('/api/board')).json()) as { widgets: Widget[] },
    }));
    const specs = b.widgets.map((w) => w.spec).filter((s): s is Made['spec'] => s.kind === 'display' && s.type !== 'news' && s.type !== 'positions');
    const made = await numbersRun(specs, me.account_id);
    const board = await clientFromEnv('runner', 'board', stackEnv());
    for (const m of made) await board(BOARD.putResult, { params: { widget_id: m.spec.widget_id }, body: m.body });

    const tonight = made.find((m) => m.spec.type === 'events' && !('folder_id' in m.spec.place))!;
    const id = tonight.spec.widget_id;
    const games = tonight.spec.params.event_keys ?? [];
    // The run made a line for every game: 8 points each.
    expect(tonight.body.result.numbers.filter((n) => n.op === 'price_at').length).toBe(games.length * 8);
    const tile = page.locator(`#board > .w[data-id="${id}"]`);
    const resize = async (size: 'L' | 'M') => {
      const status = await page.evaluate(
        async ([id, size]) => (await fetch(`/api/widgets/${id}/size`, { method: 'PATCH', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ size }) })).status,
        [id, size] as const,
      );
      expect(status).toBe(200);
      await page.reload();
      await ready(page);
      await expect.poll(() => page.locator(`#board > .w[data-id="${id}"].w--${size.toLowerCase()}`).count(), { timeout: 30_000 }).toBe(1);
      await expect.poll(async () => (await rowsOf(page, id)).rows.map((r) => r.points), { timeout: 30_000 }).toEqual(games.map(() => 8));
      await settled(page);
      await tile.scrollIntoViewIfNeeded();
    };

    for (const [theme, name, mode] of [
      ['agent-mail', 'Agent Mail', 'light'],
      ['ice', 'Ice', 'dark'],
    ] as const) {
      const shot = (n: string) => page.screenshot({ path: join(SHOTS, `w1-2-7-${theme}-${mode}-${n}.png`) });
      await page.emulateMedia({ colorScheme: mode });
      await page.locator('#look-btn').click();
      const look = page.locator('.surface.sheet');
      await look.locator('.theme-chip', { hasText: name }).click();
      const save = page.waitForResponse((r) => r.url().endsWith('/api/look') && r.request().method() === 'PUT');
      await look.locator('[data-mode-set]', { hasText: mode === 'dark' ? 'Dark' : 'Light' }).click();
      expect((await save).status()).toBe(200);
      await page.keyboard.press('Escape');
      await settled(page);

      await resize('L');
      await shot('large');
      const large = await rowsOf(page, id);
      expect(large.rows.length).toBe(games.length);
      for (const r of large.rows) {
        expect(r.shown, `${r.name}: line shown`).toBe(true);
        // Under the name, beside the chance: the rows hold their line, not air.
        expect(r.w, `${r.name}: line width`).toBeGreaterThan(120);
        expect(r.h, `${r.name}: line height`).toBeGreaterThan(20);
        expect(r.inside, `${r.name}: inside the card`).toBe(true);
      }
      expect(large.moving).toBe(0);
      // A real board can list 6 games (weekBoard): two more rows still fit, each with room for its line.
      const six = await page.evaluate((id) => {
        const box = document.querySelector(`#board > .w[data-id="${id}"] .games`)!;
        const rows = [...box.children].slice(0, 6 - box.children.length);
        const copies = rows.map((r) => box.appendChild(r.cloneNode(true)));
        return copies.length;
      }, id);
      if (six) {
        const crowded = await rowsOf(page, id);
        expect(crowded.rows.length).toBe(6);
        for (const r of crowded.rows) {
          expect(r.h, `${r.name}: line height with 6 games`).toBeGreaterThan(8);
          expect(r.inside, `${r.name}: inside the card with 6 games`).toBe(true);
        }
      }

      await resize('M');
      await shot('medium');
      const medium = await rowsOf(page, id);
      expect(medium.height).toBeLessThan(large.height);
      for (const r of medium.rows) {
        expect(r.shown, `${r.name}: line shown (medium)`).toBe(true);
        expect(r.w, `${r.name}: line width (medium)`).toBeGreaterThan(30);
        expect(r.h, `${r.name}: line height (medium)`).toBeGreaterThan(10);
        expect(r.inside, `${r.name}: inside the medium card`).toBe(true);
      }
      expect(medium.moving).toBe(0);
    }

    expect(problems).toEqual([]);
    await ctx.close();
  }, 240_000);
});
