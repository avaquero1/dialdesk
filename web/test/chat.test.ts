/**
 * The chat in a real browser, on the local stack (`make web-e2e`): the desktop panel and the phone pill open and
 * close, a message goes out through edge and the agent's guarded reply comes back whole (a calm shimmer while it
 * works), the history reloads with the board, the first visit's picks render and a tap sends one, and a limit shows
 * a plain line. The errors and the slow reply come from page.route; everything else, the picks too, from the stack
 * (the real agent on the models fake).
 *
 *   WEB_URL (default: this worktree's stack, web/test/stack.ts)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR (default web/test/.shots)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOCKED_CHAT_LINE } from '@app/contracts';
import { WEB_URL } from './stack.ts';

const URL0 = WEB_URL;
const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

let browser: Browser;
const problems: string[] = [];
let session: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;

async function open(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  page.on('console', (m) => {
    // The 404 and 429 this file fakes with page.route are logged as failed loads: expected here.
    // So is the door's 401 from /api/me (no session yet).
    const u = m.location().url;
    const expected = /Failed to load resource/.test(m.text()) && (u.includes('/api/chat') || (/\b401\b/.test(m.text()) && u.endsWith('/api/me')));
    if (m.type() === 'error' && !expected) problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(URL0) && !u.startsWith(URL0.replace('http', 'ws')) && !u.startsWith('data:')) problems.push(`off-origin request: ${u}`);
  });
  await page.goto(URL0 + '/');
  return page;
}
const ready = (page: Page) => page.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity), null, {
    timeout: 30_000,
    polling: 100,
  });
const agentLines = (page: Page) => page.locator('#chat-log .msg[data-role="agent"]');
const lastAgent = (page: Page) => agentLines(page).last();

async function say(page: Page, text: string) {
  const before = await agentLines(page).count();
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send').click();
  await expect.poll(() => agentLines(page).count(), { timeout: 20_000 }).toBe(before + 1);
  return (await lastAgent(page).innerText()).trim();
}

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('the chat with the agent', () => {
  it('desktop: the panel greets, a message goes out, the guarded reply comes back whole after a shimmer', async () => {
    const ctx = await browser.newContext({ ...DESKTOP, colorScheme: 'light' });
    const page = await open(ctx);
    await page.getByRole('button', { name: 'Try it as a guest' }).click();
    await ready(page);
    // The first visit: the agent speaks first; the opener is never shown.
    await expect.poll(() => agentLines(page).count(), { timeout: 20_000 }).toBe(1);
    expect(await page.locator('#chat-log .msg--me').count()).toBe(0);
    expect(await page.locator('#chat-input').isEnabled()).toBe(true);

    // While the agent works: the shimmer, never a typing spinner.
    await page.route('**/api/chat', async (r: Route) => {
      await new Promise((res) => setTimeout(res, 1500));
      await r.continue();
    });
    await page.locator('#chat-input').fill('What can you do?');
    await page.locator('#chat-send').click();
    await page.locator('#chat-log .msg--working').waitFor({ state: 'visible', timeout: 5000 });
    expect(await page.locator('#chat-log .msg--me').last().innerText()).toBe('What can you do?');
    expect(await page.locator('.typing').count()).toBe(0);
    await page.screenshot({ path: join(SHOTS, 'desktop-chat-working.png') });
    await page.locator('#chat-log .msg--working').waitFor({ state: 'detached', timeout: 20_000 });
    await page.unroute('**/api/chat');

    // The guard: advice wording never reaches the screen; the fixed line does.
    expect(await say(page, 'advice-test')).toBe(BLOCKED_CHAT_LINE);
    // A1.4.12: the chat says no move the card doesn't have (the numbers card's is the only one).
    expect(await say(page, 'should I buy the Chiefs?')).not.toMatch(/since yesterday|\b(up|down) \d+ points?/i);
    // The proposals render under the reply, each a question with [Add] [Not now].
    expect(await say(page, 'Chiefs at Bills')).toContain('Chiefs at Bills');
    expect(await lastAgent(page).locator('.chip-ask').count()).toBeGreaterThan(0);
    await settled(page);
    await page.screenshot({ path: join(SHOTS, 'desktop-chat.png') });

    // History reloads with the board.
    const lines = await page.locator('#chat-log .msg').allInnerTexts();
    await page.reload();
    await ready(page);
    await expect.poll(() => page.locator('#chat-log .msg').count(), { timeout: 20_000 }).toBe(lines.length);
    expect(await page.locator('#chat-log .msg').allInnerTexts()).toEqual(lines);

    // Close: the panel slides away and the board takes the room; the pill brings it back.
    const wide0 = (await page.locator('#board-wrap').boundingBox())!.width;
    await page.locator('#chat-close').click();
    await page.locator('#chat-fab').waitFor({ state: 'visible' });
    await settled(page);
    expect(await page.locator('#chat').isVisible()).toBe(false);
    expect((await page.locator('#board-wrap').boundingBox())!.width).toBeGreaterThan(wide0 + 300);
    await page.screenshot({ path: join(SHOTS, 'desktop-chat-closed.png') });
    await page.locator('#chat-fab').click();
    await page.locator('#chat').waitFor({ state: 'visible' });
    await settled(page);
    expect(await page.locator('#chat-fab').isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('chat-input');
    session = await ctx.storageState();
    await ctx.close();
  });

  it('a limit or a lost connection: one plain line in the chat, the words come back to try again', async () => {
    const ctx = await browser.newContext({ ...DESKTOP, colorScheme: 'dark', storageState: session });
    const page = await open(ctx);
    await ready(page);
    await expect.poll(() => agentLines(page).count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await page.route('**/api/chat', (r) =>
      r.fulfill({ status: 429, headers: { 'retry-after': '30' }, contentType: 'application/json', body: '{"error":"rate_limited","message":"slow down"}' }),
    );
    await page.locator('#chat-input').fill('Bills tonight');
    await page.locator('#chat-send').click();
    const err = page.locator('#chat-log .msg--error');
    await err.waitFor({ state: 'visible' });
    expect(await err.innerText()).toBe('Slow down a little. Try again in a minute.');
    expect(await page.locator('#chat-input').inputValue()).toBe('Bills tonight');
    expect(await page.locator('#notice.on').count()).toBe(0);
    await settled(page);
    await page.screenshot({ path: join(SHOTS, 'desktop-chat-limit.png') });
    await page.unroute('**/api/chat');
    await page.route('**/api/chat', (r) => r.abort('internetdisconnected'));
    await page.locator('#chat-send').click();
    await expect.poll(() => err.innerText()).toBe("You're offline. Your message wasn't sent. Try again when you're back.");
    expect(await err.count()).toBe(1);
    await page.unroute('**/api/chat');
    await ctx.close();
  });

  it('phone: the pill pours open into a sheet, a message goes and comes back, the scrim closes it; the pill clears the ⋯ buttons', async () => {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: 'dark', storageState: session });
    const page = await open(ctx);
    await ready(page);
    const chat = page.locator('#chat');
    expect(await chat.evaluate((e) => e.classList.contains('is-open'))).toBe(false);

    // The bottom of the board: no tile's ⋯ under the pill or the footer line.
    await page.locator('#board-wrap').evaluate((e) => e.scrollTo(0, e.scrollHeight));
    await settled(page);
    const pill = (await page.locator('.chat-glass--pill').boundingBox())!;
    const foot = (await page.locator('.foot span').boundingBox())!;
    const wrap = (await page.locator('#board-wrap').boundingBox())!;
    for (const b of await page.locator('#board .w-menu-btn').all()) {
      const r = await b.boundingBox();
      if (!r || r.y > wrap.y + wrap.height) continue; // scrolled out of view
      expect(r.y + r.height).toBeLessThanOrEqual(Math.min(pill.y, foot.y) - 8);
    }
    await page.screenshot({ path: join(SHOTS, 'phone-board-bottom.png') });

    await page.locator('#chat-input').tap();
    await page.waitForFunction(() => document.querySelector('#chat')!.classList.contains('is-open'));
    await settled(page);
    const sheet = (await page.locator('.chat-glass--sheet').boundingBox())!;
    expect(sheet.height).toBeGreaterThan(300);
    expect(await page.locator('#chat-log').isVisible()).toBe(true);
    expect(await say(page, 'advice-test')).toBe(BLOCKED_CHAT_LINE);
    await settled(page);
    await page.screenshot({ path: join(SHOTS, 'phone-chat-open.png') });

    await page.mouse.click(195, 40); // the scrim above the sheet
    await page.waitForFunction(() => !document.querySelector('#chat')!.classList.contains('is-open'));
    await settled(page);
    expect(await page.locator('#chat-log').isVisible()).toBe(false);
    expect(await page.locator('.chat-glass--sheet').evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
    // Taps pass through the closed sheet's box to the board.
    expect(await page.evaluate(([x, y]) => !document.elementFromPoint(x!, y!)?.closest('#chat'), [195, pill.y - 120])).toBe(true);
    await page.screenshot({ path: join(SHOTS, 'phone-chat-closed.png') });
    await ctx.close();
  });

  it('the first visit on a phone: leagues to tap, then teams; a tap sends the pick', async () => {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: 'light' });
    const page = await open(ctx);
    const sent: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/chat')) sent.push((r.postDataJSON() as { message: string }).message);
    });
    await page.getByRole('button', { name: 'Try it as a guest' }).tap();
    await ready(page);
    await page.locator('#chat-input').tap();
    await page.waitForFunction(() => document.querySelector('#chat')!.classList.contains('is-open'));
    const picks = page.locator('#chat-quick .chat-pick');
    await expect.poll(() => picks.allInnerTexts(), { timeout: 20_000 }).toContain('NFL');
    expect(await lastAgent(page).innerText()).toBe('Hi. Which teams or markets do you follow?');
    expect(await page.locator('#chat-log .msg--me').count()).toBe(0);
    const pb = (await picks.first().boundingBox())!;
    expect(pb.height).toBeGreaterThanOrEqual(44);
    await settled(page);
    await page.screenshot({ path: join(SHOTS, 'phone-first-visit-leagues.png') });

    await picks.filter({ hasText: /^NFL$/ }).tap();
    await expect.poll(() => picks.allInnerTexts(), { timeout: 20_000 }).toContain('Bills');
    expect(await picks.allInnerTexts()).not.toContain('NFL');
    expect(sent).toEqual(['Hi', 'NFL']);
    expect(await page.locator('#chat-log .msg--me').last().innerText()).toBe('NFL');
    await settled(page);
    await page.screenshot({ path: join(SHOTS, 'phone-first-visit-teams.png') });
    await picks.filter({ hasText: /^Bills$/ }).tap();
    await expect.poll(() => sent).toEqual(['Hi', 'NFL', 'Bills']);
    await expect.poll(() => picks.count(), { timeout: 20_000 }).toBe(0);
    await ctx.close();
  });

  it('had no console errors, no page errors and no off-origin requests', () => {
    expect(problems).toEqual([]);
  });
});
