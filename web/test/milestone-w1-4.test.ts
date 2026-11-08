/**
 * Milestone W1.4, safety you can see, at phone size in a real browser on the local stack (web/dev/stack.sh up;
 * `make web-e2e`). audit runs for real there and counts the log.
 *
 * The test plays the runner with the runner's own Valkey user and board token from .env. It sends what a research run
 * sends, in order: run.started, run.step (the plan: 3 articles; each read in its sealed box), the poisoned page's step
 * with its box killed, run.poisoned, then the kept clean result with the blocked page. It writes the sealed boxes' audit
 * rows as the manager would. On screen: the live line appears, the box is destroyed, the Blocked words show, the
 * widget's number stays, and the safety chip's counts go up. Then "since you last looked" after a new result, and the
 * offline words. The shots include a sequence of the moment, for the video.
 *
 *   WEB_URL (default: this worktree's stack, web/test/stack.ts)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR (default web/test/.shots)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD, POISONED_NOTE, newId, type RunTraceStep } from '@app/contracts';
import { busFromConfig, clientFromEnv, logEntry } from '@app/service-kit';
import { sampleResult } from '@app/testkit';
import { WEB_URL, stackEnv } from './stack.ts';

const URL0 = WEB_URL;
const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });
const shot = (p: Page, name: string) => p.screenshot({ path: join(SHOTS, `w1-4-${name}.png`) });

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const problems: string[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** expect.poll for beforeAll (vitest allows that one only inside a test). */
async function until<T>(f: () => Promise<T>, want: T, ms: number) {
  const end = Date.now() + ms;
  let got: T | undefined;
  while (Date.now() < end) {
    got = await f().catch(() => undefined);
    if (got === want) return;
    await wait(200);
  }
  throw new Error(`waited ${ms} ms for ${JSON.stringify(want)}, last ${JSON.stringify(got)}`);
}
const ready = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (p: Page) =>
  p.waitForFunction(() => !document.querySelector('.surface.is-closing, #board > .w.is-new') && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'), null, {
    timeout: 30_000,
    polling: 100,
  });

describe('Milestone W1.4: the containment moment on screen (phone)', () => {
  const env = stackEnv();
  const bus = busFromConfig('runner', { VALKEY_URL: env.RUNNER_VALKEY_URL });
  let board: Awaited<ReturnType<typeof clientFromEnv>>;
  const T = { account_id: '', widget_id: '', title: '' };
  let clean: ReturnType<typeof sampleResult>;
  const tile = () => page.locator(`#board > .w[data-id="${T.widget_id}"]`);
  const line = () => tile().locator('.w-live.on .wl-text');
  const big = () => tile().locator('.w-in .big').first().innerText();
  const chip = () => page.locator('#safety-chip');
  const sm = (action: string, subject_id: string, rest: Record<string, unknown> = {}) => bus.log(logEntry('sandbox-manager', action, { account_id: T.account_id, subject_id, ...rest }));
  const at = () => new Date().toISOString();

  beforeAll(async () => {
    board = await clientFromEnv('runner', 'board', env);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
    page = await ctx.newPage();
    page.on('console', (m) => {
      const expected = /Failed to load resource/.test(m.text()) && /\b401\b/.test(m.text()) && m.location().url.endsWith('/api/me');
      if (m.type() === 'error' && !expected && !/ERR_INTERNET_DISCONNECTED/.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(URL0 + '/');
    // A new user signs up (edge allows 5 guests an hour per address, and the other browser files use them).
    await page.locator('input[name="email"]').fill(`moment-${Date.now()}@example.com`);
    await page.locator('input[name="password"]').fill('a long test password');
    await page.getByRole('button', { name: 'Create my board' }).tap();
    await ready(page);
    const { me, b } = await page.evaluate(async () => ({
      me: (await (await fetch('/api/me')).json()) as { account_id: string },
      b: (await (await fetch('/api/board')).json()) as { widgets: { spec: { widget_id: string; title: string; type?: string; place: object } }[] },
    }));
    const one = b.widgets.map((w) => w.spec).find((s) => s.type === 'probability' && !('folder_id' in s.place));
    expect(one, 'the first board has one market').toBeTruthy();
    Object.assign(T, { account_id: me.account_id, widget_id: one!.widget_id, title: one!.title });

    // An earlier clean research run: 3 articles read in 3 sealed boxes, 62% on the widget.
    for (const s of ['sbx_m01', 'sbx_m02', 'sbx_m03']) await sm('sandbox.created', s, { ids: { kind: 'browse' } });
    // The math step's compute box: a sealed box, but not an article (the chip counts articles_read).
    await sm('sandbox.created', 'sbx_m00', { ids: { kind: 'compute' } });
    for (const s of ['sbx_m01', 'sbx_m02', 'sbx_m03']) await sm('sandbox.destroyed', s);
    clean = sampleResult(T.widget_id, T.account_id, 'pass');
    clean.result.numbers[0]!.value = 0.62;
    clean.result.as_of = new Date(Date.now() - 60_000).toISOString();
    clean.result.created_at = at();
    await board(BOARD.putResult, { params: { widget_id: T.widget_id }, body: clean });
    await until(big, '62%', 20_000);
    await until(() => chip().getAttribute('data-read'), '3', 20_000);
    await settled(page);
  }, 180_000);

  afterAll(async () => {
    await bus.close().catch(() => {});
    await browser?.close();
  });

  it('a research run shows its live line, the poisoned page’s box is destroyed, the widget keeps 62% and says Blocked', async () => {
    await expect.poll(() => chip().getAttribute('aria-label'), { timeout: 5000 }).toBe('Safety: 3 articles read safely today');
    expect(await chip().innerText()).toBe('3 read safely');
    await shot(page, '0-before');

    const run_id = newId('run');
    const base = { run_id, widget_id: T.widget_id, duration_ms: 800, proxy: null, verdict_id: null, receipt_ids: [], audit_row_id: null, note: null, source: null, sandbox: null };
    let seq = 0;
    const step = (s: Partial<RunTraceStep> & Pick<RunTraceStep, 'step' | 'status'>) =>
      bus.emit('run.step', { account_id: T.account_id, at: at(), step: { ...base, seq: seq++, at: at(), ...s } });
    const src = (n: number, domain: string) => ({ candidate_id: newId('cnd'), url: `https://${domain}/nfl/story-${n}.html`, domain, screenshot_key: null });
    const [a, bad, c] = [src(1, 'sportswire.fixture.test'), src(2, 'extra.fixture.test'), src(3, 'gridiron.fixture.test')];

    await bus.emit('run.started', { account_id: T.account_id, at: at(), widget_id: T.widget_id, run_id, kind: 'research' });
    await expect.poll(() => tile().evaluate((e) => e.classList.contains('is-running')), { timeout: 10_000 }).toBe(true);
    await step({ step: 'sources', status: 'ok', note: '4 allowed candidate(s)' });
    await step({ step: 'plan', status: 'ok', note: 'planner plan; 3 source(s)' });
    await expect.poll(() => line().innerText(), { timeout: 10_000 }).toBe('Reading 3 articles in sealed boxes…');
    await expect.poll(() => tile().locator('.wl-box').count(), { timeout: 5000 }).toBe(3);
    // The calm shimmer, not a spinner: on a phone it sweeps once when the run starts (the speed rules); nothing else in the tile moves.
    const shimmer = await tile().evaluate((e) => {
      const s = e.querySelector('.w-shimmer')!;
      return { name: getComputedStyle(s).animationName, iter: getComputedStyle(s).animationIterationCount, spinners: e.querySelectorAll('[class*="spin"]').length };
    });
    expect(shimmer).toEqual({ name: 'shimmer', iter: '1', spinners: 0 });
    for (const s of ['sbx_m04', 'sbx_m05', 'sbx_m06']) await sm('sandbox.created', s, { ids: { kind: 'browse' } });
    await step({ step: 'read', status: 'ok', source: a, sandbox: { sandbox_id: 'sbx_m04', state: 'held' }, proxy: { allowed: 3, refused: 0 } });
    await step({ step: 'read', status: 'ok', source: bad, sandbox: { sandbox_id: 'sbx_m05', state: 'held' }, proxy: { allowed: 1, refused: 4 } });
    await step({ step: 'extract', status: 'ok', sandbox: { sandbox_id: 'sbx_m04', state: 'released' }, note: '1 fact(s)' });
    await expect.poll(() => tile().locator('.wl-box').evaluateAll((els) => els.map((e) => e.className.replace('wl-box ', ''))), { timeout: 10_000 }).toEqual([
      'is-done',
      'is-reading',
      'is-sealed',
    ]);
    await shot(page, '1-reading');
    await tile().screenshot({ path: join(SHOTS, 'w1-4-1-reading-tile.png') });

    await tile().screenshot({ path: join(SHOTS, 'w1-4-2-moment-before.png') });
    // The trick: the guard flags the page, its sealed box is killed. The sequence is the video's moment.
    await sm('sandbox.killed', 'sbx_m05', { outcome: 'killed' });
    await sm('proxy.refused', 'sbx_m05', { sizes: { requests: 4 } });
    await bus.log(logEntry('runner', 'run.poisoned', { account_id: T.account_id, subject_id: T.widget_id, ids: { sandbox_id: 'sbx_m05' } }));
    await step({ step: 'extract', status: 'poisoned', sandbox: { sandbox_id: 'sbx_m05', state: 'killed' }, note: POISONED_NOTE });
    await bus.emit('run.poisoned', { account_id: T.account_id, at: at(), widget_id: T.widget_id, run_id, reason: 'poison', sandbox_id: 'sbx_m05', audit_row_id: null });
    await tile().locator('.wl-box.is-destroyed').waitFor({ timeout: 10_000 });
    // The video's sequence: the box's move held at set times (a screenshot takes longer than the whole move).
    const frames: string[] = [];
    for (const ms of [0, 150, 270, 420, 560, 700, 900]) {
      await tile()
        .locator('.wl-box.is-destroyed')
        .evaluate((e, t) => e.getAnimations().forEach((a) => ((a.currentTime = t), a.pause())), ms);
      const name = `2-moment-${String(frames.length).padStart(2, '0')}-${ms}ms`;
      await tile().screenshot({ path: join(SHOTS, `w1-4-${name}.png`) });
      frames.push(name);
    }
    await tile().locator('.wl-box.is-destroyed').evaluate((e) => e.getAnimations().forEach((a) => a.play()));
    await page.waitForFunction((id) => document.querySelector(`#board > .w[data-id="${id}"] .wl-box.is-destroyed`)!.getAnimations().length === 0 || document.querySelector(`#board > .w[data-id="${id}"] .wl-box.is-destroyed`)!.getAnimations().every((a) => a.playState === 'finished'), T.widget_id, { timeout: 5000 });
    // The box's one move: it swells, turns red and is gone (transform and opacity only).
    const box = await tile().locator('.wl-box.is-destroyed').evaluate((e) => ({ name: getComputedStyle(e).animationName, opacity: getComputedStyle(e).opacity }));
    expect(box).toEqual({ name: 'box-destroyed', opacity: '0' });
    await expect.poll(() => line().innerText(), { timeout: 5000 }).toBe('Blocked: this page tried to trick the agent. Its sealed box was destroyed.');
    await expect.poll(() => tile().locator('.w-live').getAttribute('data-tone'), { timeout: 5000 }).toBe('blocked');
    expect(await big()).toBe('62%');
    await shot(page, '3-blocked');

    // The run goes on: the third article, the math, the check; board keeps the last clean numbers with the blocked page.
    await step({ step: 'read', status: 'ok', source: c, sandbox: { sandbox_id: 'sbx_m06', state: 'held' } });
    await step({ step: 'extract', status: 'ok', sandbox: { sandbox_id: 'sbx_m06', state: 'released' }, note: '1 fact(s)' });
    for (const s of ['sbx_m04', 'sbx_m05', 'sbx_m06']) await sm('sandbox.destroyed', s);
    await step({ step: 'math', status: 'ok' });
    await step({ step: 'guard', status: 'ok' });
    expect(await line().innerText()).toMatch(/^Blocked: /);
    const kept = structuredClone(clean);
    kept.result.result_id = newId('res');
    kept.result.run_id = run_id;
    kept.result.created_at = at();
    kept.result.sources.push({ candidate_id: bad.candidate_id, url: bad.url, domain: bad.domain, outlet: null, published_at: null, status: 'blocked' });
    kept.result.blocked = [{ candidate_id: bad.candidate_id, domain: bad.domain, reason: 'poison', note: POISONED_NOTE, killed_at: at(), audit_row_id: null }];
    kept.trace = kept.trace.map((s) => ({ ...s, run_id }));
    await board(BOARD.putResult, { params: { widget_id: T.widget_id }, body: kept });
    await step({ step: 'publish', status: 'ok' });

    // After the run: no shimmer, the same 62%, and the Blocked words stay on the widget. The page's words never show.
    await expect.poll(() => tile().evaluate((e) => e.classList.contains('is-running')), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => line().innerText(), { timeout: 5000 }).toBe('Blocked: this page tried to trick the agent. Its sealed box was destroyed.');
    expect(await big()).toBe('62%');
    const text = await page.locator('body').innerText();
    expect(text).not.toContain('orders');
    expect(text).not.toContain('extra.fixture.test');

    // The chip: 6 articles read safely today, 1 trick blocked (audit's counts through edge).
    await expect.poll(() => chip().getAttribute('aria-label'), { timeout: 20_000 }).toBe('Safety: 6 articles read safely today · 1 trick blocked');
    expect(await chip().innerText()).toBe('1 trick blocked');
    // The count is articles_read (browse boxes), not every sealed box: the compute box isn't an article.
    const counts = await page.evaluate(() => fetch('/api/trust').then((r) => r.json()).then((j) => j.counts as { sandboxes_created: number; articles_read: number }));
    expect(counts).toMatchObject({ sandboxes_created: 7, articles_read: 6 });
    await settled(page);
    await shot(page, '4-after');
    await tile().screenshot({ path: join(SHOTS, 'w1-4-4-after-tile.png') });
    expect(frames.length).toBe(7);
  }, 120_000);

  it('the chip opens the Safety sheet, with the same counts', async () => {
    await chip().tap();
    await page.locator('.surface.sheet.is-open').waitFor({ timeout: 10_000 });
    await settled(page);
    // The sheet says what the chip says.
    const sheetText = (await page.locator('.surface.sheet.is-open').innerText()).replace(/\s+/g, ' ');
    expect(sheetText).toContain('6 articles read in sealed boxes');
    expect(sheetText).toContain('1 trick blocked');
    await shot(page, '5-chip-opens-safety');
    await page.locator('.surface.sheet.is-open [data-close]').first().tap();
    await page.waitForFunction(() => !document.querySelector('.surface.sheet'), null, { timeout: 10_000 });
  });

  it('since you last looked: a result that came while the user was away says what changed', async () => {
    await page.goto('about:blank');
    await wait(3500); // away for longer than the stack's visit gap (BOARD_VISIT_GAP_S=3)
    // What runner measures from: the result the owner saw at the last read (board keeps the visits).
    const base = (await board(BOARD.getWidget, { params: { widget_id: T.widget_id }, query: { account_id: T.account_id } })).baseline!;
    const next = structuredClone(clean);
    next.result.result_id = newId('res');
    next.result.run_id = newId('run');
    next.result.numbers[0]!.value = 0.66;
    next.result.created_at = at();
    next.result.as_of = at();
    next.trace = next.trace.map((s) => ({ ...s, run_id: next.result.run_id }));
    // The engine's move since then, as runner's run sends it (a gap op with its receipt).
    const gap = { ...next.result.receipts[0]!, id: 'r-5e5e5e5e', op_id: 'since_1', op: 'gap' as const, unit: 'points' as const, value: 4, args: { a_cents: 62, b_cents: 66 }, formula: 'gap = b_cents - a_cents' };
    next.result.since = { from_result_id: base.result_id, numbers: [{ id: 'since_1', op: 'gap', unit: 'points', value: 4, receipt_id: gap.id }], receipts: [gap] };
    await board(BOARD.putResult, { params: { widget_id: T.widget_id }, body: next });
    await page.goto(URL0 + '/');
    await ready(page);
    await expect.poll(big, { timeout: 10_000 }).toBe('66%');
    await expect.poll(() => line().innerText(), { timeout: 10_000 }).toBe('Since you last looked: up 4 points');
    await expect.poll(() => tile().locator('.w-live').getAttribute('data-tone'), { timeout: 5000 }).toBe('since');
    await settled(page);
    await shot(page, '6-since-you-last-looked');
  });

  it('offline: plain words, and they go when the connection is back', async () => {
    await ctx.setOffline(true);
    await expect.poll(() => page.locator('#notice.on').innerText().catch(() => ''), { timeout: 10_000 }).toBe("You're offline. Your board will catch up when you're back.");
    await shot(page, '7-offline');
    await ctx.setOffline(false);
    await expect.poll(() => page.locator('#notice.on').count(), { timeout: 10_000 }).toBe(0);
    expect(problems).toEqual([]);
  });
});

