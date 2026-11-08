/**
 * Milestone W1.2's end-to-end check, at phone size, on the local stack (`make web-e2e`): the first board shows all six
 * displays, each with its real content for its state (Your account before a connection, News before its first run), and
 * all five apps open. No screen says an inside word. The test plays the runner for the numbers, as displays.test.ts does.
 *
 *   WEB_URL (default: this worktree's stack, web/test/stack.ts)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR (default web/test/.shots)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, BOARD, type Widget } from '@app/contracts';
import { clientFromEnv } from '@app/service-kit';
import { numbersRun, type Made } from './display-results.ts';
import { WEB_URL, stackEnv, stackService } from './stack.ts';

const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });
/** The words design.md section 3 keeps off every screen. */
const INSIDE_WORDS = /implied probability|\bpts\b|sandbox|receipt|\bsources\b|\bEV\b|betting/i;

let browser: Browser;
let page: Page;
const problems: string[] = [];
const ready = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (p: Page) =>
  p.waitForFunction(
    () => !document.querySelector('.surface.is-closing, #board > .w.is-new') && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'),
    null,
    { timeout: 30_000, polling: 100 },
  );
const sheet = () => page.locator('.surface.sheet.is-open');
const words = (t: string) => t.replace(/\s+/g, ' ').trim();

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
  const email = `w1-2-${Date.now()}@example.com`;
  const password = 'a long test password';
  const env = { ...stackEnv(), EDGE_URL_ACCOUNTS: stackService('accounts'), EDGE_URL_BOARD: stackService('board') };
  // Log in rather than sign up: the web files share edge's small sign-up budget.
  const made = await (await clientFromEnv('edge', 'accounts', env))(ACCOUNTS.signup, { body: { email, password } });
  await (await clientFromEnv('edge', 'board', env))(BOARD.createDefaults, { params: { account_id: made.account.account_id }, body: { category: 'sports' } });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  page = await ctx.newPage();
  page.on('console', (m) => {
    const expected = /Failed to load resource/.test(m.text()) && /\b401\b/.test(m.text()) && m.location().url.endsWith('/api/me');
    if (m.type() === 'error' && !expected) problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(WEB_URL + '/');
  await page.getByRole('tab', { name: 'Log in' }).tap();
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Log in' }).last().tap();
  await ready(page);
  await settled(page);
});
afterAll(async () => {
  await browser?.close();
});

describe('W1.2: the six displays and five apps at phone size', () => {
  let widgets: Widget[];
  const tile = (type: string) => {
    const w = widgets.find((x) => x.spec.kind === 'display' && x.spec.type === type && !('folder_id' in x.spec.place))!;
    expect(w, `the first board has a ${type} display`).toBeTruthy();
    return page.locator(`#board > .w[data-id="${w.spec.widget_id}"]`);
  };

  it('the first board shows all six displays, each with its real content', async () => {
    const { me, b } = await page.evaluate(async () => ({
      me: (await (await fetch('/api/me')).json()) as { account_id: string },
      b: (await (await fetch('/api/board')).json()) as { widgets: Widget[] },
    }));
    widgets = b.widgets;
    expect(await page.locator('#board > .w--display').count()).toBe(6);
    for (const t of ['events', 'probability', 'gap', 'news', 'positions', 'movement']) await expect.poll(() => tile(t).isVisible()).toBe(true);

    // The runner's part: the numbers run for the board's displays (News and Your account keep their first state).
    const specs = b.widgets.map((w) => w.spec).filter((s): s is Made['spec'] => s.kind === 'display' && s.type !== 'news' && s.type !== 'positions');
    const made = await numbersRun(specs, me.account_id);
    const board = await clientFromEnv('runner', 'board', stackEnv());
    for (const m of made) await board(BOARD.putResult, { params: { widget_id: m.spec.widget_id }, body: m.body });
    await expect.poll(async () => words(await tile('probability').innerText()), { timeout: 30_000 }).toMatch(/Home teams won \d+% of \d+ (NFL|NBA) games on Kalshi this season\./);
    await settled(page);

    const tonight = words(await tile('events').innerText());
    expect(tonight).toMatch(/^Tonight/);
    expect(tonight).toMatch(/\d+%\s*[▲▼—]\s*(up \d+|down \d+|no change)/);
    const market = words(await tile('probability').innerText());
    expect(market).toMatch(/\d+% chance/);
    expect(market).toMatch(/Kalshi \d+¢/);
    expect(market).toMatch(/Polymarket \d+¢/);
    expect(market).toContain('for a YES that pays $1');
    expect(words(await tile('gap').innerText())).toMatch(/^Two prices.*(Kalshi \d+¢ Polymarket \d+¢.*(\d+ points? apart|The same price on both)|Not compared)/);
    const news = words(await tile('news').innerText());
    expect(news).toMatch(/We’re reading the first articles now|The first news comes/);
    expect(news).toContain('in its own sealed box');
    expect(words(await tile('positions').innerText())).toContain('Not connected');
    expect(words(await tile('movement').innerText())).toMatch(/^Biggest move .+ at .+ \d+% chance (▲|▼|—) (Up|Down|No change)/);

    // A number is read in words on each display that has numbers.
    await expect(tile('events').locator('.game').first().getAttribute('aria-label')).resolves.toMatch(/, \d+ percent chance, (up|down|no change)/);
    await expect(tile('probability').locator('.c-left').getAttribute('aria-label')).resolves.toMatch(/\d+ percent chance, (up|down|no change)/);
    await expect(tile('movement').locator('.mvt').getAttribute('aria-label')).resolves.toMatch(/\d+ percent chance/);

    const text = await page.locator('#board').innerText();
    expect(text, 'no inside word on the board').not.toMatch(INSIDE_WORDS);
    await page.screenshot({ path: join(SHOTS, 'w1-2-board.png'), fullPage: true });
  });

  const APPS: [string, RegExp][] = [
    ['Safety', /sealed box/i],
    ['How we got it', /How we got/i],
    ['Accounts', /Kalshi[\s\S]*Polymarket/],
    ['Add', /Tonight[\s\S]*Biggest move/],
    ['Settings', /Theme, mode and color/],
  ];
  for (const [name, content] of APPS)
    it(`the app "${name}" opens with its content`, async () => {
      // The tile with its label, as the other browser tests tap it: a touch at the exact centre of the icon lands on the ⋯ button.
      await page.locator(`#board > .w[aria-label="${name}"]`).tap();
      await sheet().waitFor();
      await settled(page);
      const text = await sheet().innerText();
      expect(text).toMatch(content);
      expect(text, `no inside word in ${name}`).not.toMatch(INSIDE_WORDS);
      await page.screenshot({ path: join(SHOTS, `w1-2-app-${name.replace(/ /g, '-').toLowerCase()}.png`) });
      await page.keyboard.press('Escape');
      await sheet().waitFor({ state: 'detached' });
      await settled(page);
    });

  it('no errors in the console', () => {
    expect(problems).toEqual([]);
  });
});
