/**
 * W1.2.6 at phone size, in a real browser on the local stack (web/dev/stack.sh up; `make web-e2e`): Add asks "Which game?"
 * for a market card and adds the game tapped.
 *
 * The local stack's markets is the fake (only the catalog's made-up games), so edge's real answer there is no question
 * (that path: addsettings.test.ts, and edge/test/add.test.ts on the recorded live markets). Here the page's
 * GET /api/add/probability is answered with this week's games as edge gives them on the recording, and the chip's
 * POST /api/widgets is checked for the game's event_key, then sent on without it (the fake markets has no real game to
 * add). On screen:
 * - a tap on "A market" opens "Which game?" under the row with one chip per game, in plain words;
 * - a second tap closes it;
 * - a tap on a chip sends that game, the sheet drains, the card pours in, and the toast names the game.
 *
 *   WEB_URL (default: this worktree's stack, web/test/stack.ts)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR (default web/test/.shots)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_URL } from './stack.ts';

const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `w1-2-6-${name}.png`) });

const CHOICES = [
  { event_key: 'nfl-2026-11-08-nyj-kc', label: 'Jets at Chiefs, Sun 1 PM' },
  { event_key: 'nfl-2026-11-09-buf-min', label: 'Bills at Vikings, Mon 8:15 PM' },
  { event_key: 'nfl-2026-11-08-tb-chi', label: 'Buccaneers at Bears, Sun 8:20 PM' },
  { event_key: 'nba-2026-11-07-nyk-cle', label: 'Knicks at Cavaliers, Sat 8 PM' },
  { event_key: 'nba-2026-11-07-bkn-atl', label: 'Nets at Hawks, Sat 7:30 PM' },
];

let browser: Browser;
let page: Page;
const problems: string[] = [];
const sent: unknown[] = [];

const ready = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (p: Page) =>
  p.waitForFunction(
    () => !document.querySelector('.surface.is-closing, #board > .w.is-new') && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'),
    null,
    { timeout: 30_000, polling: 100 },
  );
const tile = (title: string) => page.locator(`#board > .w:not(.is-out)[aria-label="${title}"]`);
const sheet = () => page.locator('.surface.sheet.is-open');

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.route('**/api/add/probability', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: CHOICES }) }));
  await page.route('**/api/widgets', async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    const body = r.request().postDataJSON() as { type: string; event_key?: string };
    sent.push(body);
    await r.continue({ postData: JSON.stringify({ type: body.type }) });
  });
  // A sign-up, not a guest: the web files share one address, and edge allows 5 guests an hour from it.
  await page.goto(WEB_URL);
  const status = await page.evaluate(
    (email) => fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'addgames-test-1' }) }).then((r) => r.status),
    `addgames-${Date.now()}@example.com`,
  );
  expect(status).toBe(201);
  await page.reload();
  await ready(page);
  await settled(page);
  problems.length = 0; // the door's /api/me before sign-up answers 401, as it should
});
afterAll(async () => {
  await browser?.close();
});

describe('Add asks "Which game?" for a market card, at phone size', () => {
  it('a tap on A market opens the games as chips; a second tap closes them', async () => {
    await tile('Add').tap();
    await sheet().waitFor();
    await settled(page);
    await sheet().locator('.add-row[data-add="probability"]').tap();
    const chips = sheet().locator('.add-games .add-game');
    await chips.first().waitFor();
    expect(await sheet().locator('.add-games .sf-h').innerText()).toBe('Which game?');
    expect(await chips.allInnerTexts()).toEqual(CHOICES.map((c) => c.label));
    expect(await sheet().locator('.add-row[data-add="probability"]').getAttribute('aria-expanded')).toBe('true');
    // Each chip is a full tap target, inside the phone's width (measured once the chips' entrance is over).
    await page.waitForFunction(() => [...document.querySelectorAll('.add-game')].every((b) => b.getAnimations().every((a) => a.playState !== 'running')), null, { timeout: 10_000, polling: 100 });
    for (const b of await chips.all()) {
      const box = (await b.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    expect(sent).toEqual([]);
    await shot(page, '1-which-game');

    await sheet().locator('.add-row[data-add="probability"]').tap();
    await expect.poll(() => sheet().locator('.add-games').count()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a tap on a game sends that game, the sheet drains and the card pours in', async () => {
    const cards = () => page.evaluate(() => fetch('/api/board').then((r) => r.json()).then((b: { widgets: { spec: { type?: string; widget_id: string } }[] }) => b.widgets.filter((w) => w.spec.type === 'probability').length));
    const before = await cards();
    await sheet().locator('.add-row[data-add="probability"]').tap();
    await sheet().locator('.add-game').nth(1).tap();
    await page.waitForFunction(() => !!document.querySelector('#board > .w.is-new'), null, { timeout: 10_000, polling: 'raf' });
    expect(sent).toEqual([{ type: 'probability', event_key: 'nfl-2026-11-09-buf-min' }]);
    expect(await page.locator('#toast').innerText()).toBe('Bills at Vikings added to your board.');
    expect(await page.locator('.surface.sheet.is-open').count()).toBe(0);
    expect(await cards()).toBe(before + 1);
    await settled(page);
    await shot(page, '2-added');
    expect(problems).toEqual([]);
  });
});
