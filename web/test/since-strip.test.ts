/**
 * W1.5.3 in a real browser on the local stack (web/dev/stack.sh up; `make web-e2e`), in two themes, light and dark.
 * A new user signs up by email and the board's displays get a result, then a newer one with a since move while the user
 * is away. Every tile's strip shows; no tile's words sit under it or are cut, at phone and desktop size. A tap on the
 * lowest tile's strip opens the move's steps, read from its receipts. A strip with nothing but "new items" has no receipt
 * to open and does nothing on tap.
 *
 *   WEB_URL (default: this worktree's stack, web/test/stack.ts)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD, POISONED_NOTE, newId, type ResultSince, type Widget } from '@app/contracts';
import { clientFromEnv } from '@app/service-kit';
import { sampleResult } from '@app/testkit';
import { numbersRun, type Made } from './display-results.ts';
import { WEB_URL, stackEnv } from './stack.ts';

const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });

let browser: Browser;
const signups: number[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ready = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (p: Page) =>
  p.waitForFunction(() => !document.querySelector('.surface.is-closing, #board > .w.is-new') && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'), null, {
    timeout: 30_000,
    polling: 100,
  });

/** Each tile with a strip: words under it, words or item boxes the tile cuts, words on top of other words, and its tap height. */
const measure = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#board > .w')].flatMap((w) => {
      const strip = w.querySelector<HTMLElement>(':scope > .w-live.on[data-tone="since"]');
      if (!strip) return [];
      const inner = w.querySelector<HTMLElement>(':scope > .w-in')!.getBoundingClientRect();
      const top = strip.getBoundingClientRect().top;
      const covered: string[] = [];
      const cut: string[] = [];
      const seen: { r: DOMRect; n: Text }[] = [];
      for (const it of w.querySelectorAll<HTMLElement>(':scope > .w-in .item')) {
        const b = it.getBoundingClientRect();
        if (b.height && b.top < inner.bottom && b.bottom > inner.bottom + 0.5) cut.push(`item: ${it.innerText.slice(0, 40)}`);
      }
      const walk = document.createTreeWalker(w.querySelector(':scope > .w-in')!, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        const n = walk.currentNode as Text;
        if (!n.data.trim()) continue;
        let shown = true;
        for (let e = n.parentElement; e && e !== w; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) shown = false;
        }
        if (!shown) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.height === 0 || r.top >= inner.bottom) continue;
          if (r.bottom > top + 0.5) covered.push(n.data.trim().slice(0, 50));
          // A range's rect is the font's box; a tight line-height (the big numbers) draws inside a shorter line.
          const lh = parseFloat(getComputedStyle(n.parentElement!).lineHeight);
          const trim = lh < r.height ? (r.height - lh) / 2 : 0;
          if (r.bottom - trim > inner.bottom + 0.5) cut.push(n.data.trim().slice(0, 50));
          seen.push({ r, n });
        }
      }
      const overlap = seen.flatMap((a, i) =>
        seen.slice(i + 1).flatMap((b) => (a.n !== b.n && Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left) > 1 && Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top) > 2 ? [`${a.n.data.trim().slice(0, 30)} / ${b.n.data.trim().slice(0, 30)}`] : [])),
      );
      const open = strip.querySelector<HTMLElement>('.wl-open');
      return [{ id: w.dataset.id!, size: w.className.match(/w--([sml])/)?.[1], covered, cut, overlap, open: open ? open.getBoundingClientRect().height : null, words: strip.innerText }];
    }),
  );

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
});
// The web files share one address and edge allows 5 sign-ups, then one per 2 minutes: this file's two sign-ups are given
// back before it ends, so another file doesn't get a 429.
afterAll(async () => {
  await browser?.close();
  if (signups.length) await wait(Math.max(0, signups[0]! + signups.length * 125_000 - Date.now()));
}, 300_000);

describe('W1.5.3: the since strip opens its receipt and covers nothing', () => {
  for (const [theme, name, mode] of [
    ['agent-mail', 'Agent Mail', 'light'],
    ['deep-sea', 'Deep Sea', 'dark'],
  ] as const) {
    it(`a tap opens the move's steps, and the strip covers no tile's words (${name}, ${mode})`, async () => {
      const problems: string[] = [];
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: mode });
      const page = await ctx.newPage();
      page.on('console', (m) => {
        const expected = /Failed to load resource/.test(m.text()) && /\b401\b/.test(m.text()) && m.location().url.endsWith('/api/me');
        if (m.type() === 'error' && !expected) problems.push(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      const shot = (n: string) => page.screenshot({ path: join(SHOTS, `${theme}-${mode}-${n}.png`) });

      const tile = (id: string) => page.locator(`#board > .w[data-id="${id}"]`);
      await page.goto(WEB_URL + '/');
      await page.locator('input[name="email"]').fill(`since-${theme}-${Date.now()}@example.com`);
      await page.locator('input[name="password"]').fill('a long test password');
      signups.push(Date.now());
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

      const board = await clientFromEnv('runner', 'board', stackEnv());
      const { me, b } = await page.evaluate(async () => ({
        me: (await (await fetch('/api/me')).json()) as { account_id: string },
        b: (await (await fetch('/api/board')).json()) as { widgets: Widget[] },
      }));
      const displays = b.widgets.map((w) => w.spec).filter((s) => s.kind === 'display' && !('folder_id' in s.place));
      const news = displays.find((s) => s.kind === 'display' && s.type === 'news')!;
      const lastPlain = displays.find((s) => s.kind === 'display' && s.type === 'probability')!;
      expect(news && lastPlain, 'the first board has News and a market').toBeTruthy();

      // An earlier result on every display: what the owner sees at this visit. Real numbers where runner's plans make them.
      const made = await numbersRun(displays.filter((s) => s.kind === 'display' && s.type !== 'news' && s.type !== 'positions' && s.widget_id !== lastPlain.widget_id) as Made['spec'][], me.account_id);
      const real = new Map(made.map((m) => [m.spec.widget_id, m.body]));
      const firsts = new Map<string, ReturnType<typeof sampleResult>>();
      for (const s of displays) {
        const clean = real.get(s.widget_id) ?? sampleResult(s.widget_id, me.account_id, 'pass');
        clean.result.as_of = new Date(Date.now() - 3_600_000).toISOString();
        clean.result.created_at = new Date(Date.now() - 3_600_000).toISOString();
        await board(BOARD.putResult, { params: { widget_id: s.widget_id }, body: clean });
        firsts.set(s.widget_id, clean);
      }
      await wait(3500); // past the stack's visit gap, so the next read is a visit that saw these results
      await page.reload();
      await ready(page);
      await settled(page);

      // The medium News tile is the tightest fit: an article, a blocked page and a note. The first board may already have it.
      if (!(await tile(news.widget_id).evaluate((e) => e.classList.contains('w--m')))) {
        await tile(news.widget_id).locator('.w-menu-btn').tap();
        await page.locator('.surface.menu.is-open').waitFor();
        await settled(page);
        const saved = page.waitForResponse((r) => r.url().endsWith('/api/board/layout') && r.request().method() === 'PUT');
        await page.locator('.surface.menu.is-open [data-size="M"]').tap();
        expect((await saved).status()).toBe(200);
        await page.waitForFunction((i) => document.querySelector(`#board > .w[data-id="${i}"]`)?.classList.contains('w--m'), news.widget_id);
        await page.waitForFunction(() => !document.querySelector('.surface'), null, { timeout: 10_000 }).catch(() => page.keyboard.press('Escape'));
        await settled(page);
      }

      // Away for longer than the stack's visit gap; meanwhile new results come, each with the engine's move from what was seen.
      await page.goto('about:blank');
      await wait(3500);
      let newsSeen = '';
      let lastSince: ResultSince | undefined;
      for (const s of displays) {
        const was = firsts.get(s.widget_id)!;
        const base = (await board(BOARD.getWidget, { params: { widget_id: s.widget_id }, query: { account_id: me.account_id } })).baseline!;
        const next = structuredClone(was);
        next.result.result_id = newId('res');
        next.result.run_id = newId('run');
        next.result.as_of = new Date().toISOString();
        next.result.created_at = new Date().toISOString();
        next.trace = next.trace.map((t) => ({ ...t, run_id: next.result.run_id }));
        next.result.facts = next.result.facts.map((f) => ({ ...f, claim: `${f.claim} More came in.` }));
        if (s.widget_id === news.widget_id) {
          newsSeen = next.result.result_id;
          const bad = newId('cnd');
          next.result.sources = [...next.result.sources, { candidate_id: bad, url: 'https://extra.fixture.test/nfl/a.html', domain: 'extra.fixture.test', outlet: 'Extra', published_at: null, status: 'blocked' }];
          next.result.blocked = [{ candidate_id: bad, domain: 'extra.fixture.test', reason: 'poison', note: POISONED_NOTE, killed_at: new Date().toISOString(), audit_row_id: null }];
          next.result.notes = ['One item was left out because it read like advice.'];
        }
        // One market gets new items only: no move, no receipt, nothing to open.
        if (s.widget_id !== lastPlain.widget_id) {
          const gap = {
            ...sampleResult(s.widget_id, me.account_id, 'pass').result.receipts[1]!,
            id: 'r-5e5e5e5e',
            op_id: 'since_1',
            op: 'gap' as const,
            unit: 'points' as const,
            value: 4,
            args: { a_cents: 62, b_cents: 66 },
            formula: 'gap = b_cents - a_cents',
            provenance: {
              a_cents: { source: 'kalshi:KXNFLGAME-TEST', as_of: was.result.as_of },
              b_cents: { source: 'kalshi:KXNFLGAME-TEST', as_of: next.result.as_of },
            },
          };
          next.result.since = { from_result_id: base.result_id, numbers: [{ id: 'since_1', op: 'gap', unit: 'points', value: 4, receipt_id: gap.id }], receipts: [gap] };
        }
        await board(BOARD.putResult, { params: { widget_id: s.widget_id }, body: next });
        if (s.widget_id === news.widget_id) lastSince = next.result.since;
      }
      await page.goto(WEB_URL + '/');
      await ready(page);

      const strip = (id: string) => tile(id).locator('.w-live.on');
      await expect.poll(() => strip(news.widget_id).getAttribute('data-tone'), { timeout: 10_000 }).toBe('since');
      await expect.poll(() => strip(news.widget_id).locator('.wl-text').innerText(), { timeout: 10_000 }).toBe('Since you last looked: up 4 points');
      await settled(page);

      const atPhone = await measure(page);
      await tile(news.widget_id).scrollIntoViewIfNeeded();
      await settled(page);
      await shot('board');
      expect(atPhone.length, 'every display shows its strip').toBe(displays.length);
      expect(await tile(news.widget_id).innerText(), 'the guard\'s note stays on the card').toContain('One item was left out because it read like advice.');
      expect(atPhone.filter((t) => t.covered.length || t.cut.length || t.overlap.length), 'no words under a strip or cut, phone').toEqual([]);
      expect(atPhone.filter((t) => t.open !== null && t.open < 44), 'a strip with a move is a 44 px target').toEqual([]);

      // A strip with no move: no button, and a tap on it does nothing.
      expect(atPhone.find((t) => t.id === lastPlain.widget_id)!.open).toBeNull();
      await strip(lastPlain.widget_id).scrollIntoViewIfNeeded();
      await strip(lastPlain.widget_id).tap({ force: true }); // a finger on the line: it lets the tap through to the tile
      await wait(600);
      expect(await page.locator('.surface.sheet').count()).toBe(0);

      // The lowest tile's strip opens the move's steps, read from its receipts.
      const open = strip(news.widget_id).locator('.wl-open');
      await tile(news.widget_id).scrollIntoViewIfNeeded();
      await open.tap();
      const sheet = page.locator('.surface.sheet.is-open');
      await sheet.waitFor();
      await settled(page);
      const words = await sheet.innerText();
      expect(words).toMatch(/How we got this/);
      expect(words).toMatch(/Up 4 points since you last looked/);
      expect(words).toMatch(/Where the prices came from[\s\S]*Kalshi: 62¢ at \d{1,2}:\d\d\s?[AP]M, then 66¢ at \d{1,2}:\d\d\s?[AP]M\./);
      expect(words).toMatch(/The math[\s\S]*66¢ minus 62¢[\s\S]*Up 4 points/);
      expect(words).toMatch(/Worked out by our math engine/);
      expect(words).toMatch(/The safety check/);
      await shot('since-steps');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.surface'), null, { timeout: 10_000 });
      await settled(page);

      // Desktop: the same tiles at a wider size.
      await page.setViewportSize({ width: 1280, height: 800 });
      await settled(page);
      const atDesk = await measure(page);
      await tile(news.widget_id).scrollIntoViewIfNeeded();
      await settled(page);
      await shot('board-desktop');
      expect(atDesk.length).toBe(displays.length);
      expect(atDesk.filter((t) => t.covered.length || t.cut.length || t.overlap.length), 'no words under a strip or cut, desktop').toEqual([]);
      expect(atDesk.filter((t) => t.open !== null && t.open < 44), 'a 44 px target on desktop').toEqual([]);

      await page.setViewportSize({ width: 390, height: 844 });
      await settled(page);

      // A medium News tile with three clean articles and no blocked page: the third gives way to the strip.
      const three = sampleResult(news.widget_id, me.account_id, 'pass');
      three.result.created_at = new Date().toISOString();
      three.result.as_of = three.result.created_at;
      const src = three.result.sources[0]!;
      const more = ['two', 'three'].map((k) => ({ ...src, candidate_id: newId('cnd'), url: `https://sportswire.fixture.test/nfl/${k}.html` }));
      three.result.sources.push(...more);
      three.result.facts.push(...more.map((m, i) => ({ fact_id: `f${i + 2}`, candidate_id: m.candidate_id, claim: `Report ${['two', 'three'][i]} says the line moved.`, quote: 'the line moved' })));
      await wait(3500); // past the visit gap: the board's next read is a new visit, whose baseline is the result just seen
      three.result.since = { ...structuredClone(lastSince!), from_result_id: newsSeen };
      await board(BOARD.putResult, { params: { widget_id: news.widget_id }, body: three });
      await expect.poll(() => tile(news.widget_id).innerText(), { timeout: 20_000 }).toContain('Report two says');
      await expect.poll(() => strip(news.widget_id).getAttribute('data-tone'), { timeout: 10_000 }).toBe('since');
      await settled(page);
      const threeItems = await measure(page);
      expect(threeItems.some((t) => t.id === news.widget_id), 'the news tile still shows its strip').toBe(true);
      expect(threeItems.filter((t) => t.covered.length || t.cut.length || t.overlap.length), 'three articles and the strip').toEqual([]);
      await tile(news.widget_id).scrollIntoViewIfNeeded();
      await settled(page);
      await shot('news-three');

      expect(problems).toEqual([]);
      await ctx.close();
    }, 240_000);
  }
});
