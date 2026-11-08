/**
 * W1.1's end-to-end check at phone size, signed up by email, in a light and a dark theme: move a card, make a folder by
 * drag and drop, add a card, take cards out, rename, clear a card back to its defaults and undo it, reload and the
 * layout is still there. Each change shows at once and is only sent when its Undo offer ends.
 *
 *   WEB_URL (default: this worktree's stack, web/test/stack.ts)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR (default web/test/.shots)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_URL } from './stack.ts';

const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });
const UNDO_MS = 5000;
const CASES = [
  { theme: 'agent-mail', mode: 'light' },
  { theme: 'obsidian', mode: 'dark' },
] as const;

type W = { spec: { widget_id: string; kind: string; title: string; children?: string[]; place: { col?: number; row?: number; folder_id?: string; index?: number } } };

describe.each(CASES)('folders by drag and drop on a phone, $theme ($mode)', ({ theme, mode }) => {
  let browser: Browser;
  let page: Page;
  let cdp: CDPSession;
  let signedUpAt = 0;
  const problems: string[] = [];
  /** Board-changing calls the page sent: "METHOD path" and, for folders and layout, the body. */
  const sent: { what: string; body: unknown }[] = [];
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${theme}-${mode}-${name}.png`) });
  const ready = () => page.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
  const settled = () =>
    page.waitForFunction(
      () => !document.querySelector('.surface.is-closing, #board > .w.is-new, #board > .w.is-out') && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'),
      null,
      { timeout: 30_000, polling: 100 },
    );
  const server = () => page.evaluate(() => fetch('/api/board').then((r) => r.json() as Promise<{ widgets: W[] }>)).then((b) => b.widgets);
  /** The grid as the user sees it, top-left first. */
  const grid = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('#board > .w'))
        .filter((w) => !w.classList.contains('is-out') && !w.classList.contains('is-merging'))
        .map((w) => ({ id: w.dataset.id!, r: w.getBoundingClientRect(), kind: w.dataset.kind! }))
        .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
        .map((t) => ({ id: t.id, kind: t.kind, x: t.r.left, y: t.r.top, w: t.r.width, h: t.r.height })),
    );
  const ids = async () => (await grid()).map((t) => t.id);
  const undoToast = () => page.locator('.undo-toast');
  const tapUndo = () => undoToast().getByRole('button', { name: 'Undo' }).tap();
  /** The Undo offer is up, then has ended (its change is sent). */
  const waitOffer = async () => {
    await page.waitForFunction(() => !!document.querySelector('.undo-toast.on'), null, { timeout: 5000, polling: 50 });
    await page.waitForFunction(() => !document.querySelector('.undo-toast.on'), null, { timeout: UNDO_MS + 3000, polling: 100 });
  };
  const tile = (id: string) => page.locator(`#board > .w[data-id="${id}"]`);

  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', x?: number, y?: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y: y! }] });
  /** A finger: hold on `from` until the card lifts, slide to `to`, then `at` runs before the finger comes up. */
  async function drag(from: { x: number; y: number }, to: { x: number; y: number }, at?: () => Promise<void>, steps = 18) {
    await touch('touchStart', from.x, from.y);
    await page.waitForTimeout(440);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await page.waitForTimeout(16);
    }
    try {
      await at?.();
    } finally {
      await touch('touchEnd');
    }
  }
  /** The hover has armed: the target shows it will become a folder. */
  const armed = (id: string) => page.waitForFunction((x) => !!document.querySelector(`#board > .w[data-id="${x}"].is-merge`), id, { timeout: 5000, polling: 30 });
  const middleOf = (t: { x: number; y: number; w: number; h: number }) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 });
  const movingLayers = () =>
    page.evaluate(() => {
      const on = new Set<Element>();
      for (const a of document.getAnimations()) {
        const t = (a.effect as KeyframeEffect).target as Element | null;
        const w = t?.closest('#board > .w, #slot');
        if (w && a.playState === 'running') on.add(w);
      }
      return on.size;
    });

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: mode });
    page = await ctx.newPage();
    cdp = await ctx.newCDPSession(page);
    page.on('console', (m) => {
      // The door's "is there a session?" answers 401, and the refused name is the test's own 400.
      if (m.type() === 'error' && !/\/api\/me$|\/title$/.test(m.location().url)) problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (r.method() === 'GET' || !(u.pathname === '/api/folders' || u.pathname === '/api/board/layout' || u.pathname.startsWith('/api/widgets/'))) return;
      sent.push({ what: `${r.method()} ${u.pathname}`, body: r.postData() ? JSON.parse(r.postData()!) : null });
    });
    await page.goto(WEB_URL);
    await page.locator('input[name="email"]').fill(`folders-${theme}-${Date.now()}@example.com`);
    await page.locator('input[name="password"]').fill('folders-test-pass-1');
    await page.getByRole('button', { name: 'Create my board' }).tap();
    await ready();
    signedUpAt = Date.now();
    await page.evaluate((look) => fetch('/api/look', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(look) }), { theme, mode, hue: null });
    await page.reload();
    await ready();
    await settled();
    expect(await page.evaluate(() => document.documentElement.dataset.mode)).toBe(mode);
  }, 120_000);
  // Sign-ups share edge's limit across the web test files (5, then 1 per 2 minutes): give this one's token back.
  afterAll(async () => {
    await browser?.close();
    if (signedUpAt) await new Promise((r) => setTimeout(r, Math.max(0, signedUpAt + 125_000 - Date.now())));
  }, 180_000);

  /** Two display cards on the screen right now, the first above or left of the second, far enough apart to hover. */
  async function twoCards() {
    const cards = (await grid()).filter((t) => t.kind === 'display' && t.y + t.h < 760);
    return cards.slice(0, 2) as [typeof cards[0], typeof cards[0]];
  }

  it('moves a card, and keeps the move after the offer', async () => {
    const before = await ids();
    const [a, b] = await twoCards();
    // Near the edge of the next card: a reorder, not a folder.
    await drag(middleOf(a), { x: b.x + b.w - 8, y: b.y + b.h - 8 }, async () => {
      await expect.poll(ids, { timeout: 5000 }).not.toEqual(before);
      expect(await page.locator('#board .w.is-merge').count()).toBe(0);
      expect(await movingLayers()).toBeLessThanOrEqual(4);
    });
    await settled();
    await expect.poll(ids, { timeout: 15_000 }).not.toEqual(before);
    expect(sent.at(-1)?.what).toBe('PUT /api/board/layout');
    await shot('1-moved');
    expect(problems).toEqual([]);
  }, 60_000);

  it('shows the target will become a folder, makes it at once with Undo, and Undo sends nothing', async () => {
    const [a, b] = await twoCards();
    const count = (await grid()).length;
    const calls = sent.length;
    await drag(middleOf(a), middleOf(b), async () => {
      await armed(b.id);
      expect(await movingLayers()).toBeLessThanOrEqual(4);
      await shot('2-hover');
    }, 1);
    await expect.poll(async () => (await grid()).length).toBe(count - 1);
    expect((await grid()).filter((t) => t.kind === 'folder').some((f) => f.id.startsWith('tmp_'))).toBe(true);
    expect(await undoToast().locator('.u-text').textContent()).toBe('Made a folder.');
    expect(sent.length).toBe(calls);
    await settled();
    await shot('3-made');
    await tapUndo();
    await expect.poll(async () => (await ids()).sort()).toEqual([a.id, b.id, ...(await ids()).filter((x) => x !== a.id && x !== b.id)].sort());
    await page.waitForTimeout(UNDO_MS + 400);
    expect(sent.length).toBe(calls);
  }, 60_000);

  let folderId = '';
  it('sends a made folder when the offer ends; the title comes from the server', async () => {
    const [a, b] = await twoCards();
    await drag(middleOf(a), middleOf(b), () => armed(b.id).then(() => {}), 1);
    await waitOffer();
    await expect.poll(() => sent.some((c) => c.what === 'POST /api/folders'), { timeout: 8_000 }).toBe(true);
    const post = sent.find((c) => c.what === 'POST /api/folders')!;
    expect((post.body as { widget_ids: string[] }).widget_ids).toEqual([b.id, a.id]);
    expect((post.body as { title?: string }).title).toBeUndefined();
    const f = (await server()).find((w) => w.spec.kind === 'folder' && w.spec.children?.includes(a.id))!;
    expect(f.spec.children).toEqual([b.id, a.id]);
    folderId = f.spec.widget_id;
    await expect.poll(() => tile(folderId).count()).toBe(1);
    await settled();
    expect(await tile(folderId).locator('.a-label').textContent()).toBe(f.spec.title);
  }, 60_000);

  it('a second change inside the offer: drop a third card on the new folder, and the folder goes first', async () => {
    const [a, b] = await twoCards();
    const c0 = sent.length;
    await drag(middleOf(a), middleOf(b), () => armed(b.id).then(() => {}), 1);
    await expect.poll(() => grid().then((g) => g.some((t) => t.id.startsWith('tmp_')))).toBe(true);
    await settled();
    // The new folder is a temporary tile right now; a third card goes straight onto it.
    const g = await grid();
    const f = g.find((t) => t.id.startsWith('tmp_'))!;
    const c = g.find((t) => t.kind === 'display' && t.y + t.h < 760)!;
    // In one move: cards it passes over on the way swap if the finger dwells on them.
    await drag(middleOf(c), middleOf(f), async () => {
      await armed(f.id);
    }, 1);
    await waitOffer();
    await expect.poll(() => sent.slice(c0).map((s) => s.what).join(), { timeout: 10_000 }).toBe('POST /api/folders,PUT /api/board/layout');
    await expect.poll(() => server().then((b) => b.find((w) => w.spec.kind === 'folder' && w.spec.children?.includes(c.id))?.spec.children?.length), { timeout: 8_000 }).toBe(3);
    const made = (await server()).find((w) => w.spec.kind === 'folder' && w.spec.children?.includes(c.id))!;
    expect(made.spec.children).toHaveLength(3);
    expect((sent.at(-1)!.body as { places: { place: { folder_id: string } }[] }).places[0]!.place.folder_id).toBe(made.spec.widget_id);
    await expect.poll(() => tile(made.spec.widget_id).count()).toBe(1);
    folderId = made.spec.widget_id;
    await settled();
    await shot('4-three-in-folder');
    expect(problems).toEqual([]);
  }, 60_000);

  it('renames by a tap on the name, with Undo, and a refused name comes back with a plain message', async () => {
    await tile(folderId).tap();
    await page.locator('.surface.folder-open.is-open').waitFor();
    await settled();
    const name = await page.locator('h2.fo-title').textContent();
    const rename = async (text: string) => {
      await page.locator('h2.fo-title').tap();
      await page.locator('input.fo-title-in').fill(text);
      expect(await page.locator('input.fo-title-in').inputValue()).toBe(text.replace(/[<>]/g, ''));
      await page.locator('input.fo-title-in').press('Enter');
    };
    await rename('Big <games>');
    await expect.poll(() => page.locator('h2.fo-title').textContent()).toBe('Big games');
    expect(await tile(folderId).locator('.a-label').textContent()).toBe('Big games');
    const c0 = sent.length;
    await tapUndo();
    await expect.poll(() => page.locator('h2.fo-title').textContent()).toBe(name);
    expect(sent.length).toBe(c0);

    // The server refuses: the name goes back, in plain words.
    await page.route('**/api/widgets/*/title', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"bad_title"}' }));
    await rename('Refused name');
    await waitOffer();
    await expect.poll(() => page.locator('#toast').textContent()).toContain('That name can’t be used');
    await expect.poll(() => page.locator('h2.fo-title').textContent()).toBe(name);
    await page.unroute('**/api/widgets/*/title');

    await rename('Big games');
    await waitOffer();
    await expect.poll(() => sent.some((c) => c.what === `PATCH /api/widgets/${folderId}/title`)).toBe(true);
    await expect.poll(() => server().then((s) => s.find((w) => w.spec.widget_id === folderId)?.spec.title)).toBe('Big games');
    await shot('5-renamed');
    await page.locator('[data-close]').tap();
    await settled();
  }, 60_000);

  /** Long-press a card in the open folder and drag it up over the board; drop. */
  async function dragOut(toX = 100, toY = 130) {
    await tile(folderId).tap();
    await page.locator('.surface.folder-open.is-open').waitFor();
    await settled();
    const c = (await page.locator('.fo-grid .card').first().boundingBox())!;
    await drag({ x: c.x + c.width / 2, y: c.y + c.height / 2 }, { x: toX, y: toY }, async () => {
      expect(await page.locator('.card-ghost').count()).toBe(1);
      await shot('6-dragging-out');
      // A slow drag: the sheet has finished draining and the finger is still down.
      await page.waitForTimeout(1300);
      expect(await page.locator('.card-ghost').count()).toBe(1);
    });
  }

  it('drags a card out of the open folder; the folder stays with one card and goes with the last', async () => {
    const c0 = sent.length;
    const inFolder = async () => (await server()).find((w) => w.spec.widget_id === folderId)?.spec.children?.length ?? 0;
    await dragOut();
    await expect.poll(() => tile(folderId).locator('.a-label').count()).toBe(1);
    await waitOffer();
    await expect.poll(inFolder).toBe(2);
    await settled();
    await dragOut();
    await waitOffer();
    await expect.poll(inFolder).toBe(1);
    await settled();
    await shot('7-one-left');
    // The last card: the folder goes at once and Undo brings it back; let it go the second time.
    await dragOut();
    await expect.poll(() => tile(folderId).count()).toBe(0);
    await tapUndo();
    await expect.poll(() => tile(folderId).count()).toBe(1);
    await settled();
    await dragOut();
    await expect.poll(() => tile(folderId).count()).toBe(0);
    await waitOffer();
    await expect.poll(() => sent.slice(c0).some((s) => s.what === `DELETE /api/widgets/${folderId}`), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => server().then((s) => s.some((w) => w.spec.widget_id === folderId))).toBe(false);
    const inFolders = (await server()).filter((w) => w.spec.place.folder_id === folderId);
    expect(inFolders).toEqual([]);
    await settled();
    expect(problems).toEqual([]);
  }, 90_000);

  it('clears a card back to its defaults and undoes it; after a reload the layout is still there', async () => {
    const [a] = await twoCards();
    await tile(a.id).locator('.w-menu-btn').tap();
    await page.locator('.surface.menu.is-open').waitFor();
    await settled();
    const clear = page.locator('.surface.menu [data-act="clear"]');
    await clear.tap();
    await clear.tap();
    await expect.poll(() => undoToast().evaluate((u) => u.classList.contains('on'))).toBe(true);
    const c0 = sent.length;
    await tapUndo();
    await page.waitForTimeout(400);
    expect(sent.length).toBe(c0);

    await settled();
    const before = await ids();
    await page.reload();
    await ready();
    await settled();
    expect(await ids()).toEqual(before);
    await shot('8-after-reload');
    expect(problems).toEqual([]);
  }, 60_000);
});
