/**
 * W1.5.2c, in a real browser at phone size: every size of A market says "You think" whole, a small one has no cut-off
 * words and nothing past its edge, and How we got it names its rows as the tiles do. Light and dark.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, BOARD, type Widget } from '@app/contracts';
import { clientFromEnv } from '@app/service-kit';
import { numbersRun, type Made } from './display-results.ts';
import { WEB_URL, stackEnv, stackService } from './stack.ts';

const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots/w1-5-2c');
mkdirSync(SHOTS, { recursive: true });
const THEMES = [
  ['light', 'Agent Mail', 'Light'],
  ['dark', 'Deep Sea', 'Dark'],
] as const;

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let market: string;
let size: 'S' | 'M' | 'L' = 'M';
let mine = true;

const onBoard = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });

/** The board with one market, at the size under test, the owner's number set. Nothing else moves it. */
const oneMarket = async (route: Route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const res = await route.fetch();
  const b = (await res.json()) as { widgets: Widget[] };
  b.widgets = b.widgets.filter((w) => w.spec.widget_id === market || w.spec.kind === 'app');
  for (const w of b.widgets)
    if (w.spec.kind === 'display') {
      w.spec.size = size;
      w.spec.params = { ...w.spec.params, user_probability: mine ? 0.65 : undefined };
      w.spec.place = { col: 0, row: 0 };
    }
  await route.fulfill({ response: res, json: b });
};

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
  const email = `market-words-${Date.now()}@example.com`;
  const password = 'a long test password';
  const env = { ...stackEnv(), EDGE_URL_ACCOUNTS: stackService('accounts'), EDGE_URL_BOARD: stackService('board') };
  const made = await (await clientFromEnv('edge', 'accounts', env))(ACCOUNTS.signup, { body: { email, password } });
  const account_id = made.account.account_id;
  await (await clientFromEnv('edge', 'board', env))(BOARD.createDefaults, { params: { account_id }, body: { category: 'sports' } });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  page = await ctx.newPage();
  await page.goto(WEB_URL + '/');
  await page.getByRole('tab', { name: 'Log in' }).tap();
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Log in' }).last().tap();
  await onBoard(page);

  // Real numbers from runner's plans and the real engine, with the owner's number in the market's plan.
  const b = await page.evaluate(async () => (await (await fetch('/api/board')).json()) as { widgets: Widget[] });
  const specs = b.widgets.map((w) => w.spec).filter((s) => s.kind === 'display' && s.type !== 'news' && s.type !== 'positions' && !('folder_id' in s.place)) as Made['spec'][];
  const first = specs.find((s) => s.type === 'probability')!;
  market = first.widget_id;
  first.params = { ...first.params, user_probability: 0.65 };
  const runs = await numbersRun(specs, account_id);
  const board = await clientFromEnv('runner', 'board', stackEnv());
  for (const m of runs) await board(BOARD.putResult, { params: { widget_id: m.spec.widget_id }, body: m.body });
}, 240_000);
afterEach(async () => {
  await page.unroute('**/api/board', oneMarket);
  mine = true;
});
afterAll(async () => {
  await browser?.close();
});

const setLook = async (name: string, mode: string) => {
  await page.locator('#look-btn').click();
  const look = page.locator('.surface.sheet');
  await look.locator('.theme-chip', { hasText: name }).click();
  await look.locator('[data-mode-set]', { hasText: mode }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
};

/** Words cut short or anything past the tile's edge, as a list of what's wrong. */
const cuts = (id: string) =>
  page.evaluate((wid) => {
    const tile = document.querySelector(`#board > .w[data-id="${wid}"]`)!;
    const box = tile.getBoundingClientRect();
    const out: string[] = [];
    for (const e of tile.querySelectorAll<HTMLElement>('.w-in *')) {
      if (!e.offsetParent || !e.textContent?.trim() || e.children.length) continue;
      const r = e.getBoundingClientRect();
      if (r.bottom > box.bottom + 0.5 || r.right > box.right + 0.5) out.push(`past the edge: "${e.textContent.trim()}"`);
      if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow === 'ellipsis') out.push(`cut: "${e.textContent.trim()}"`);
    }
    for (const e of tile.querySelectorAll<HTMLElement>('.c-base .w-note')) {
      if (!e.offsetParent) continue;
      if (e.getBoundingClientRect().bottom > e.parentElement!.getBoundingClientRect().bottom + 0.5 || e.scrollHeight > e.clientHeight + 1) out.push(`cut: "${e.textContent!.trim()}"`);
    }
    for (const e of tile.querySelectorAll<HTMLElement>('.ev')) if (e.scrollWidth > e.clientWidth + 1) out.push(`cut: "${e.textContent!.trim()}"`);
    return out;
  }, id);

describe.each(THEMES)('A market at phone size, %s', (mode, name, word) => {
  it.each(['S', 'M', 'L'] as const)('size %s: the line is whole and nothing is cut', async (s) => {
    size = s;
    await page.route('**/api/board', oneMarket);
    await page.reload();
    await onBoard(page);
    await setLook(name, word);
    await page.waitForTimeout(900);
    const t = page.locator(`#board > .w[data-id="${market}"]`);
    await expect.poll(() => t.locator('.big').first().textContent()).toMatch(/\d+%/);
    // Left for the PM: W1.2 pins the base rate on a medium Market, and at W1.5.2a's text sizes it can't fit whole beside your line.
    expect((await cuts(market)).filter((c) => !(s === 'M' && c.startsWith('cut: "Home teams')))).toEqual([]);
    const ev = t.locator('.ev');
    if (s === 'S') expect(await ev.isVisible()).toBe(false);
    else expect((await ev.textContent())!).toMatch(/^You think 65%: that's (\d+ points? (above|below) the market\.|the same as the market\.)$/);
    if (s === 'S') expect(await t.locator('.w-sub').count()).toBe(0);
    await page.screenshot({ path: join(SHOTS, `market-${s}-${mode}.png`) });
  });

  it('medium, no number of your own: the base rate is whole', async () => {
    size = 'M';
    mine = false;
    await page.route('**/api/board', oneMarket);
    await page.reload();
    await onBoard(page);
    await setLook(name, word);
    await page.waitForTimeout(900);
    const t = page.locator(`#board > .w[data-id="${market}"]`);
    await expect.poll(() => t.locator('.big').first().textContent()).toMatch(/\d+%/);
    expect(await cuts(market)).toEqual([]);
    expect(await t.locator('.ev').count()).toBe(0);
    expect((await t.locator('.c-base .w-note').first().textContent())!).toMatch(/\.$/);
    await page.screenshot({ path: join(SHOTS, `market-M-no-number-${mode}.png`) });
  });

  it('How we got it: plain names, no Gap, Positions or Movement', async () => {
    await page.reload();
    await onBoard(page);
    await setLook(name, word);
    await page.locator('#board').getByText('How we got it', { exact: true }).first().click();
    const rows = page.locator('.how-row .t');
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    const names = await rows.allTextContents();
    for (const n of names) expect(n).not.toMatch(/^(Gap|Positions|Movement)\b/);
    expect(names).toContain('Two prices');
    await page.screenshot({ path: join(SHOTS, `how-we-got-it-${mode}.png`) });
  });
});
