/**
 * Milestone W1.3's end-to-end check, at phone size, on the local stack (`make web-e2e`) with the real agent on the
 * models fake: a new user taps a league and a team, taps Add on the proposals, and the widgets pour in on the board;
 * "make it warmer" changes the glass (live, and saved through edge) until Undo puts it back. Not now changes
 * nothing. "Change it with the agent" opens the chat with the widget named in the input. No page.route here.
 *
 *   WEB_URL (default http://localhost:8490)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR (default web/test/.shots)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL0 = process.env.WEB_URL ?? 'http://localhost:8490';
const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

let browser: Browser;
const problems: string[] = [];

const ready = (page: Page) => page.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity), null, {
    timeout: 30_000,
    polling: 100,
  });
const shot = async (page: Page, name: string) => {
  await settled(page);
  await page.screenshot({ path: join(SHOTS, `w1-3-${name}.png`) });
};
const agentLines = (page: Page) => page.locator('#chat-log .msg[data-role="agent"]');
const titles = (page: Page) => page.locator('#board .w-title').allInnerTexts();
const isOpen = (page: Page) => page.evaluate(() => document.querySelector('#chat')!.classList.contains('is-open'));
const me = (page: Page) => page.evaluate(async () => ((await (await fetch('/api/me')).json()) as { look: { theme: string; mode: string; hue: number | null } }).look);
/** --hue on <html>, on the circle (it glides the short way round, so -140 and 220 are the same color). */
const hue = (page: Page) => page.evaluate(() => Math.round(((Number(document.documentElement.style.getPropertyValue('--hue')) % 360) + 360) % 360));

async function openSheet(page: Page) {
  if (await isOpen(page)) return;
  await page.locator('#chat-input').tap();
  await page.waitForFunction(() => document.querySelector('#chat')!.classList.contains('is-open'));
  await settled(page);
}
async function closeSheet(page: Page) {
  await page.mouse.click(195, 40); // the scrim above the sheet
  await page.waitForFunction(() => !document.querySelector('#chat')!.classList.contains('is-open'));
  await settled(page);
}
async function say(page: Page, text: string) {
  const before = await agentLines(page).count();
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send').tap();
  await expect.poll(() => agentLines(page).count(), { timeout: 20_000 }).toBe(before + 1);
  return (await agentLines(page).last().innerText()).trim();
}

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('Milestone W1.3: the chat builds the board', () => {
  it('a new user taps a league and a team, adds the proposals, the widgets pour in; "make it warmer" until Undo', async () => {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: 'dark' });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      const expected = /Failed to load resource/.test(m.text()) && /\b401\b/.test(m.text()) && m.location().url.endsWith('/api/me');
      if (m.type() === 'error' && !expected) problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(URL0) && !u.startsWith(URL0.replace('http', 'ws')) && !u.startsWith('data:')) problems.push(`off-origin request: ${u}`);
    });
    const calls: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/proposals\//.test(r.url())) calls.push(r.url().replace(/^.*\/api\/proposals\/[^/]+\//, ''));
    });
    await page.goto(URL0 + '/');
    // A new user signs up (edge allows 5 guests an hour per address, and the other browser files use them).
    await page.locator('input[name="email"]').fill(`new-${Date.now()}@example.com`);
    await page.locator('input[name="password"]').fill('a long test password');
    await page.getByRole('button', { name: 'Create my board' }).tap();
    await ready(page);
    const start = await titles(page);
    const look0 = await me(page);
    const hue0 = await hue(page);

    // The first visit: the agent's greeting with leagues to tap, then that league's teams.
    await openSheet(page);
    const picks = page.locator('#chat-quick .chat-pick');
    await expect.poll(() => picks.allInnerTexts(), { timeout: 20_000 }).toContain('NFL');
    await shot(page, '1-leagues');
    await picks.filter({ hasText: /^NFL$/ }).tap();
    await expect.poll(() => picks.allInnerTexts(), { timeout: 20_000 }).toContain('Bills');
    await shot(page, '2-teams');
    await picks.filter({ hasText: /^Bills$/ }).tap();

    // The proposals: a question with two buttons each. Nothing on the board changed yet.
    const asks = page.locator('#chat-log .chip-ask');
    await expect.poll(() => asks.count(), { timeout: 20_000 }).toBe(2);
    expect(await asks.locator('.chip-q').allInnerTexts()).toEqual(["Add 'Chiefs at Bills news'?", "Add 'Chiefs at Bills move'?"]);
    await settled(page); // the reply rises in at scale .97: measure the buttons at rest
    for (const b of await asks.locator('button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await titles(page)).toEqual(start);
    expect(calls).toEqual([]);
    await shot(page, '3-proposals');

    // Add, and the widget pours in on the board; then the second one.
    await asks.first().getByRole('button', { name: 'Add' }).tap();
    await expect.poll(() => page.locator('#chat-log .chip-said').allInnerTexts(), { timeout: 15_000 }).toEqual(["Added 'Chiefs at Bills news'."]);
    await expect.poll(() => titles(page), { timeout: 15_000 }).toContain('Chiefs at Bills news');
    await page.locator('#chat-log .chip-ask').first().getByRole('button', { name: 'Add' }).tap();
    await expect.poll(() => titles(page), { timeout: 15_000 }).toContain('Chiefs at Bills move');
    expect(calls).toEqual(['accept', 'accept']);
    expect(await page.locator('#chat-log .chip-ask').count()).toBe(0);
    await shot(page, '4-added');
    await closeSheet(page);
    expect((await titles(page)).length).toBe(start.length + 2);
    const added = page.locator('#board [data-id]', { has: page.locator('.w-title', { hasText: 'Chiefs at Bills news' }) });
    await added.scrollIntoViewIfNeeded();
    await shot(page, '5-board-with-new-widgets');

    // "make it warmer": the glass changes live and is saved; Undo puts back the theme, mode and hue.
    await openSheet(page);
    expect(await say(page, 'make it warmer')).toContain('Done: warmer glass.');
    await expect.poll(() => hue(page)).not.toBe(hue0);
    expect(await hue(page)).toBe(32);
    await expect.poll(() => me(page).then((l) => l.hue), { timeout: 10_000 }).toBe(32);
    const undo = page.locator('#chat-log .chip-undo');
    expect(await undo.count()).toBe(1);
    await shot(page, '6-warmer');
    await closeSheet(page);
    await shot(page, '7-warmer-board');
    await openSheet(page);
    await undo.tap();
    await expect.poll(() => hue(page)).toBe(hue0);
    await expect.poll(() => me(page), { timeout: 10_000 }).toEqual(look0);
    expect(await page.locator('#chat-log .chip-undo').count()).toBe(0);
    expect(await page.locator('#chat-log .chip-said').last().innerText()).toBe('Undone: the look is back as it was.');
    await shot(page, '8-undone');

    // Not now: rejected, and the board stays as it is.
    const n = (await titles(page)).length;
    await say(page, 'Chiefs');
    await expect.poll(() => page.locator('#chat-log .chip-ask').count(), { timeout: 15_000 }).toBe(2);
    await page.locator('#chat-log .chip-ask').first().getByRole('button', { name: 'Not now' }).tap();
    await expect.poll(() => page.locator('#chat-log .chip-said').last().innerText(), { timeout: 15_000 }).toBe('Not now.');
    expect(calls.at(-1)).toBe('reject');
    expect((await titles(page)).length).toBe(n);
    await shot(page, '9-not-now');

    // A reload: the history comes back, and the decided proposals have no buttons; the pending one still asks.
    await page.reload();
    await ready(page);
    await openSheet(page);
    await expect.poll(() => page.locator('#chat-log .chip-ask').count(), { timeout: 15_000 }).toBe(1);

    // "Change it with the agent" from a widget's ⋯: the chat opens with the widget named, ready to finish.
    await closeSheet(page);
    await added.scrollIntoViewIfNeeded();
    await added.locator('.w-menu-btn').tap();
    await page.locator('.surface.menu.is-open').waitFor();
    await settled(page);
    await page.locator('.surface.menu.is-open .m-main .mi', { hasText: 'Change it with the agent' }).tap();
    await page.waitForFunction(() => document.querySelector('#chat')!.classList.contains('is-open'));
    expect(await page.locator('#chat-input').inputValue()).toBe("Change 'Chiefs at Bills news' to ");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('chat-input');
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).selectionStart)).toBe("Change 'Chiefs at Bills news' to ".length);
    await shot(page, '10-change-with-agent');
    await ctx.close();
  });

  it('had no console errors, no page errors and no off-origin requests', () => {
    expect(problems).toEqual([]);
  });
});
