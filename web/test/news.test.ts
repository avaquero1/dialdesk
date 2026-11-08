/**
 * W1.2.2 in a real browser at phone size, on the local stack (web/dev/stack.sh up; `make web-e2e`), in two themes, light
 * and dark. A new user signs up by email. Before any research, News says what will happen and about when. Then runner's
 * own run code (stack-runner.ts) runs the News display's research on the fixture site's articles, the poisoned one among
 * them, and the Your account display's numbers on a read-only Kalshi account connected in Accounts. On screen:
 * - News shows 2–3 items, each a plain line with outlet and time, and the summary's slots filled with engine numbers;
 * - the poisoned page's item is the plain blocked line and its time only: none of its words, no picture;
 * - a tap on a clean item opens How we got this at that article: outlet, time and its screenshot;
 * - Your account: money in plain words, "as of <time>", a loss an arrow and words, never red.
 * - a note from the guard's left-out facts (A1.3.6) shows on the card.
 *
 *   WEB_URL (default: this worktree's stack, web/test/stack.ts)   CHROMIUM (default /usr/bin/chromium)
 *   SHOTS_DIR (default ~/siren/domains/vultr/blast-radius-zero/planning/evidence/web-w1-2-2 when it exists, else web/test/.shots)
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtures, sampleResult } from '@app/testkit';
import { BOARD, POISONED_NOTE, newId, type Widget } from '@app/contracts';
import { clientFromEnv } from '@app/service-kit';
import { stackRunner, type StackRunner } from './stack-runner.ts';
import { WEB_URL, stackEnv } from './stack.ts';

const EVIDENCE = join(homedir(), 'siren/domains/vultr/blast-radius-zero/planning/evidence');
const SHOTS = process.env.SHOTS_DIR ?? (existsSync(EVIDENCE) ? join(EVIDENCE, 'web-w1-2-2') : join(import.meta.dirname, '.shots'));
mkdirSync(SHOTS, { recursive: true });
const PEM = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
/** Words only the poisoned page has (its hidden orders and its headline): none may reach the screen. */
const poisoned = fixtures.manifest().find((p) => p.poisoned)!;
const POISON_WORDS = [/ignore (your|all|the)? ?previous instructions/i, /nobody is telling you/i, /put everything on/i];

let browser: Browser;
let runner: StackRunner;
const ready = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (p: Page) =>
  p.waitForFunction(() => !document.querySelector('.surface.is-closing, #board > .w.is-new') && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'), null, {
    timeout: 30_000,
    polling: 100,
  });

/** A fixture article rendered the way a browse box screenshots it. */
async function articlePng(ctx: BrowserContext, html: string) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 800, height: 600 });
  // The page as served, with nothing able to load from outside (it is a fixture file).
  await p.route('**/*', (r) => r.abort());
  await p.setContent(html, { waitUntil: 'domcontentloaded' });
  const png = (await p.screenshot({ type: 'png' })).toString('base64');
  await p.close();
  return png;
}

/** A computed color as r, g, b through a canvas (a theme may give oklch). */
const rgbOf = (p: Page, sel: string) =>
  p.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const c = document.createElement('canvas').getContext('2d')!;
    c.fillStyle = cs.color;
    c.fillRect(0, 0, 1, 1);
    const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
    return { r: r!, g: g!, b: b!, shadow: cs.textShadow };
  }, sel);

let shotCtx: BrowserContext;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
  shotCtx = await browser.newContext({ javaScriptEnabled: false });
  runner = await stackRunner((_url, html) => articlePng(shotCtx, html));
});
afterAll(async () => {
  await runner?.close();
  await browser?.close();
});

describe('W1.2.2: News and Your account at phone size', () => {
  for (const [theme, name, mode] of [
    ['agent-mail', 'Agent Mail', 'light'],
    ['deep-sea', 'Deep Sea', 'dark'],
  ] as const) {
    it(`News: what comes and when, 2–3 items with outlet and time, the blocked line, a tap to the article's screenshot; Your account: a loss isn't red (${name}, ${mode})`, async () => {
      const problems: string[] = [];
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: mode });
      const page = await ctx.newPage();
      page.on('console', (m) => {
        const expected = /Failed to load resource/.test(m.text()) && /\b401\b/.test(m.text()) && m.location().url.endsWith('/api/me');
        if (m.type() === 'error' && !expected) problems.push(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      const shot = (n: string) => page.screenshot({ path: join(SHOTS, `${theme}-${mode}-${n}.png`) });
      const sheet = () => page.locator('.surface.sheet.is-open');
      const close = async () => {
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.surface'), null, { timeout: 10_000 });
      };

      const resize = async (id: string, size: 'M' | 'L') => {
        await page.locator(`#board > .w[data-id="${id}"] .w-menu-btn`).tap();
        await page.locator('.surface.menu.is-open').waitFor();
        await settled(page);
        const saved = page.waitForResponse((r) => r.url().endsWith('/api/board/layout') && r.request().method() === 'PUT');
        await page.locator(`.surface.menu.is-open [data-size="${size}"]`).tap();
        expect((await saved).status()).toBe(200);
        await page.waitForFunction(([i, c]) => document.querySelector(`#board > .w[data-id="${i}"]`)?.classList.contains(c!), [id, `w--${size.toLowerCase()}`]);
        await page.waitForFunction(() => !document.querySelector('.surface'), null, { timeout: 10_000 }).catch(() => page.keyboard.press('Escape'));
        await settled(page);
      };

      await page.goto(WEB_URL + '/');
      await page.locator('input[name="email"]').fill(`news-${theme}-${Date.now()}@example.com`);
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
      expect(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode])).toEqual([theme, mode]);

      const { me, b } = await page.evaluate(async () => ({
        me: (await (await fetch('/api/me')).json()) as { account_id: string },
        b: (await (await fetch('/api/board')).json()) as { widgets: Widget[] },
      }));
      const top = b.widgets.map((w) => w.spec).filter((s) => s.kind === 'display' && !('folder_id' in s.place));
      const news = top.find((s) => s.kind === 'display' && s.type === 'news')!;
      const pos = top.find((s) => s.kind === 'display' && s.type === 'positions')!;
      expect(news && pos, 'the first board has News and Your account').toBeTruthy();
      const newsTile = page.locator(`#board > .w[data-id="${news.widget_id}"]`);
      const posTile = page.locator(`#board > .w[data-id="${pos.widget_id}"]`);

      // 1. A new board's first research run is on its way (A1.4.4): the card says so, not an empty card.
      await newsTile.scrollIntoViewIfNeeded();
      await settled(page);
      const before = await newsTile.innerText();
      expect(before).toContain('We’re reading the first articles now. It takes a minute or two.');
      expect(before).toMatch(/We read the latest articles[^.]* from Sports Wire, Weather Desk and Fan Post, each in its own sealed box, destroyed after\./);
      await shot('news-before');

      // 2. runner's research run on the fixture site: the clean articles read, the poisoned one's box killed.
      const run = await runner.run(news.widget_id, me.account_id, 'research');
      expect(run.status).toBe('poisoned');
      const killed = run.steps.filter((s) => s.status === 'poisoned');
      expect(killed.length).toBe(1);
      await expect.poll(() => newsTile.locator('.item--blocked').count(), { timeout: 20_000 }).toBe(1);
      await settled(page);
      const got = await page.evaluate(async (id) => ((await (await fetch('/api/board')).json()) as { widgets: Widget[] }).widgets.find((w) => w.spec.widget_id === id)!.result!, news.widget_id);
      expect(got.kind).toBe('research');
      expect(got.blocked.map((x) => x.domain)).toEqual([new URL(poisoned.url).hostname]);

      const items = newsTile.locator('.items > .item');
      const n = await items.count();
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(3);
      const clean = newsTile.locator('.items > .item--tap');
      expect(await clean.count()).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < (await clean.count()); i++) {
        const meta = await clean.nth(i).locator('.meta').innerText();
        // Outlet · time: "Sports Wire · 2 days".
        expect(meta).toMatch(/^(Sports Wire|Weather Desk|Fan Post) · (just now|\d+ min|\d+ h|\d+ days?|[A-Z][a-z]{2} \d{1,2})$/);
        const line = await clean.nth(i).locator('.hl').innerText();
        expect(line.length).toBeGreaterThan(10);
        // A line the reader typed with a digit in it would be the article's quote instead.
        const f = got.facts.find((x) => x.claim.trim() === line || x.quote.trim() === line);
        expect(f, line).toBeTruthy();
        if (f!.claim.trim() === line) expect(line).not.toMatch(/[0-9]/);
      }
      // The blocked item: the plain line and its time, nothing from the page, no picture.
      const blocked = newsTile.locator('.item--blocked');
      expect((await blocked.innerText()).replace(/\s+/g, ' ').trim()).toMatch(/^Blocked: this page tried to trick the agent\. Its sealed box was destroyed\. \d{1,2}:\d\d\s?(AM|PM)?$/);
      expect(await blocked.locator('img, [data-cnd]').count()).toBe(0);
      const all = await newsTile.innerText();
      for (const w of POISON_WORDS) expect(all).not.toMatch(w);
      // Nothing on the medium tile runs over anything else.
      const fits = await newsTile.locator('.items').evaluate((e) => {
        const box = e.closest('.w')!.getBoundingClientRect();
        return { over: e.scrollHeight - e.clientHeight, past: Math.max(...[...e.children].map((c) => c.getBoundingClientRect().bottom)) - box.bottom };
      });
      expect(fits.over, 'the items fit their box').toBeLessThanOrEqual(1);
      expect(fits.past, 'the items stay inside the tile').toBeLessThanOrEqual(0);
      // audit counts the log on its own clock.
      await expect.poll(() => page.locator('#safety-chip').getAttribute('aria-label'), { timeout: 20_000 }).toMatch(/trick blocked/);
      // The run's live line has finished its fade (a shot of the card, not of the moment).
      await page.waitForFunction((id) => !document.querySelector(`#board > .w[data-id="${id}"] .w-live.on`), news.widget_id, { timeout: 30_000 });
      await settled(page);
      await page.waitForTimeout(500);
      await shot('news-after');

      // 3. A tap on a clean item: How we got this at that article, with its outlet, time and screenshot.
      const first = clean.first();
      const cnd = (await first.getAttribute('data-cnd'))!;
      const outlet = (await first.locator('.meta').innerText()).split(' · ')[0]!;
      await first.tap();
      await sheet().locator('.how-art').waitFor();
      await settled(page);
      const art = sheet().locator('.how-art');
      expect(await art.getAttribute('data-article')).toBe(cnd);
      const artText = await art.innerText();
      expect(artText).toContain(outlet);
      expect(artText).toMatch(/Published [A-Z][a-z]{2} \d{1,2}:\d\d|Published \d{1,2}:\d\d/);
      expect(artText).toMatch(/Read in a sealed box at \d{1,2}:\d\d/);
      const img = art.locator('.how-shot:not(.is-loading) img');
      await img.waitFor({ timeout: 15_000 });
      expect(await img.evaluate((e: HTMLImageElement) => (e.complete ? e.naturalWidth : 0))).toBeGreaterThan(0);
      // Only the clean pages have pictures in the sheet; the blocked one shows its site and time only.
      expect(await sheet().locator('.how-src.is-blocked img, .how-src.is-blocked .how-shot').count()).toBe(0);
      for (const w of POISON_WORDS) expect(await sheet().innerText()).not.toMatch(w);
      await shot('news-article');
      await art.locator('.how-shot').tap();
      await page.locator('.how-zoom.is-open').waitFor();
      await page.waitForTimeout(300);
      await shot('news-article-zoom');
      await page.locator('.how-zoom').tap();
      await page.waitForFunction(() => !document.querySelector('.how-zoom'));
      await close();

      // 3b. A large News tile also has room for the summary, its slots filled by code from the engine's numbers.
      await resize(news.widget_id, 'L');
      await newsTile.scrollIntoViewIfNeeded();
      await settled(page);
      expect(got.summary && Object.keys(got.summary.slots).length, 'the run wrote a summary with slots').toBeTruthy();
      const sum = await newsTile.locator('.news-sum').innerText();
      expect(sum).not.toMatch(/\{[nq]\d+\}/);
      for (const v of Object.values(got.summary!.slots)) {
        if (v.kind !== 'number' || v.format !== 'percent') continue;
        expect(sum).toContain(`${Math.round(got.numbers.find((x) => x.id === v.number_id)!.value * 100)}%`);
      }
      await shot('news-large');

      // 4. Your account: a read-only Kalshi account, shared, then runner's numbers run for the display.
      await page.locator('#board > .w[aria-label="Accounts"]').tap();
      await sheet().locator('#ac-promise').waitFor();
      await settled(page);
      await sheet().locator('input[name="key_id"]').fill('kalshi-read-key-0001');
      await sheet().locator('textarea[name="pem"]').fill(PEM);
      await sheet().locator('input[name="demo"]').check();
      await sheet().locator('#ac-kalshi .ac-go').tap();
      const row = sheet().locator('.ac-conn').first();
      await row.waitFor();
      const share = row.locator('[data-share]');
      await share.tap();
      await expect.poll(() => share.getAttribute('aria-pressed')).toBe('true');
      await expect.poll(() => row.locator('.ac-shown').innerText().catch(() => '')).toContain('Shown on Your account.');
      await close();
      const prun = await runner.run(pos.widget_id, me.account_id, 'numbers');
      expect(prun.status).toBe('done');
      await expect.poll(() => posTile.locator('.pos-item').count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await page.waitForFunction((id) => !document.querySelector(`#board > .w[data-id="${id}"] .w-live.on`), pos.widget_id, { timeout: 30_000 });
      await posTile.scrollIntoViewIfNeeded();
      await settled(page);
      await shot('account-small');
      expect(await posTile.locator('.pos-meta .only-s').innerText()).toMatch(/^as of \d{1,2}:\d\d/);
      expect(await posTile.locator('.pos-meta .only-s').isVisible(), '"as of" shows on the small tile').toBe(true);
      // Medium shows every position; the loss has to be on screen, not only in the page.
      await resize(pos.widget_id, 'M');
      await posTile.scrollIntoViewIfNeeded();
      await settled(page);
      const pt = (await posTile.innerText()).replace(/\s+/g, ' ');
      expect(pt).toMatch(/as of \d{1,2}:\d\d/);
      expect(pt).toMatch(/\$[\d,]+\.\d\d/);
      expect(pt).toMatch(/Balance · \d+ open positions?/);
      expect(pt).toMatch(/[▲▼—] (Up \$[\d,]+\.\d\d|Down \$[\d,]+\.\d\d|No change) (since you bought|today)/);
      // Plain money words: no "+$", no "−$", no "P&L".
      expect(pt).not.toMatch(/[+−-]\$|P&L|pnl/i);
      // A loss: an arrow and words in the text color, never red, and no tinted glow.
      const loss = posTile.locator('.pos-mvs .mv--down').first();
      expect(await posTile.locator('.pos-mvs .mv--down').count(), 'the fixture account has a loss').toBeGreaterThan(0);
      const inTile = await loss.evaluate((e) => {
        const t = e.closest('.w')!.getBoundingClientRect();
        const r = e.getBoundingClientRect();
        return r.top >= t.top && r.bottom <= t.bottom && r.height > 0;
      });
      expect(inTile, 'the loss is inside the tile').toBe(true);
      expect(await loss.innerText()).toMatch(/^▼\s+Down \$[\d,]+\.\d\d (since you bought|today)$/);
      const down = (await rgbOf(page, `#board > .w[data-id="${pos.widget_id}"] .pos-mvs .mv--down`))!;
      const text2 = (await rgbOf(page, `#board > .w[data-id="${pos.widget_id}"] .pos-mkt`))!;
      expect(down.shadow).toBe('none');
      expect(down.r - Math.max(down.g, down.b), `loss color ${JSON.stringify(down)}`).toBeLessThan(40);
      expect([down.r, down.g, down.b]).toEqual([text2.r, text2.g, text2.b]);
      // Every position fits the medium tile: the last line isn't cut.
      const lastFits = await posTile.locator('.pos-item').last().evaluate((e) => {
        const list = e.closest('.pos-list')!;
        return { below: e.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom, over: list.scrollHeight - list.clientHeight };
      });
      expect(lastFits.below, 'the last position is inside its list').toBeLessThanOrEqual(1);
      expect(lastFits.over, 'the list is not cut').toBeLessThanOrEqual(1);
      await shot('account');

      // 5. The guard left a fact out (A1.3.6): the result's note shows on the card, beside a clean item and a blocked page.
      await resize(news.widget_id, 'M');
      const board = await clientFromEnv('runner', 'board', stackEnv());
      const withNote = sampleResult(news.widget_id, me.account_id, 'pass');
      const bad = newId('cnd');
      withNote.result.created_at = new Date().toISOString();
      withNote.result.sources.push({ candidate_id: bad, url: poisoned.url, domain: new URL(poisoned.url).hostname, outlet: 'Fan Post', published_at: null, status: 'blocked' });
      withNote.result.blocked = [{ candidate_id: bad, domain: new URL(poisoned.url).hostname, reason: 'poison', note: POISONED_NOTE, killed_at: new Date().toISOString(), audit_row_id: null }];
      const NOTE = 'One item was left out because it read like advice.';
      withNote.result.notes = [NOTE];
      await board(BOARD.putResult, { params: { widget_id: news.widget_id }, body: withNote });
      await expect.poll(() => newsTile.innerText(), { timeout: 20_000 }).toContain(NOTE);
      await newsTile.scrollIntoViewIfNeeded();
      await settled(page);
      const noteFits = await newsTile.locator('.w-note', { hasText: NOTE }).evaluate((e) => e.getBoundingClientRect().bottom - e.closest('.w')!.getBoundingClientRect().bottom);
      expect(noteFits, 'the note stays inside the tile').toBeLessThanOrEqual(0);
      await shot('news-note');

      expect(problems).toEqual([]);
      await ctx.close();
    });
  }
});

