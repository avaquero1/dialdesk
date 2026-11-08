/**
 * The Safety app and "How we got this" at phone size, in a real browser on the local stack (web/dev/stack.sh up;
 * `make web-e2e`). audit runs for real there: it chains and signs the log that edge, accounts and board write.
 *
 * The test plays the runner, with the runner's own Valkey user and token from .env: it writes the sandbox rows a run
 * would forward (sealed boxes created and destroyed, one killed, requests stopped) and stores two results in board, a
 * numbers run on Two prices and a research run with one blocked page on News. Then it reads them on screen:
 * today's numbers in words, Check it → Verified, and How we got this from a number and from the ⋯ menu, which names
 * the blocked page's site and never quotes a page.
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
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `safety-phone-${name}.png`) });

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const problems: string[] = [];
const T = { gap: '', news: '' };
/** The display's name on screen (W1.2.1): the catalog's inside titles in plain words. */
const plain = (t: string) => ({ Gap: 'Two prices', Positions: 'Your account', Movement: 'Biggest move' } as Record<string, string>)[t] ?? t;
const TRAP = 'Sports Wire Extra';

const ready = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = (p: Page) =>
  p.waitForFunction(
    () => !document.querySelector('.surface.is-closing, #board > .w.is-new') && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'),
    null,
    { timeout: 30_000, polling: 100 },
  );
const tile = (title: string) => page.locator(`#board > .w:not(.is-out)[aria-label="${title}"]`);
const sheet = () => page.locator('.surface.sheet.is-open');

/** What a run would leave: the manager's trust rows (forwarded by the runner) and two results in board. */
async function seed(account_id: string, ids: { gap: string; news: string }) {
  const env = stackEnv();
  const bus = busFromConfig('runner', { VALKEY_URL: env.RUNNER_VALKEY_URL });
  const sm = (action: string, subject_id: string, rest: Record<string, unknown> = {}) => bus.log(logEntry('sandbox-manager', action, { account_id, subject_id, ...rest }));
  for (const s of ['sbx_safety01', 'sbx_safety02', 'sbx_safety03']) await sm('sandbox.created', s, { ids: { kind: 'browse' } });
  await sm('sandbox.created', 'sbx_safety00', { ids: { kind: 'compute' } });
  await sm('sandbox.killed', 'sbx_safety03', { outcome: 'killed' });
  await sm('proxy.refused', 'sbx_safety03', { sizes: { requests: 4 } });
  for (const s of ['sbx_safety01', 'sbx_safety02', 'sbx_safety03']) await sm('sandbox.destroyed', s);
  await bus.log(logEntry('runner', 'run.poisoned', { account_id, subject_id: ids.news, ids: { sandbox_id: 'sbx_safety03' } }));
  await bus.close();

  const board = await clientFromEnv('runner', 'board', env);
  // Two prices: a numbers run (no articles).
  const g = sampleResult(ids.gap, account_id, 'pass');
  g.result.kind = 'numbers';
  g.result.summary = null;
  g.result.facts = [];
  g.result.sources = [];
  g.phase = 'numbers' as never;
  await board(BOARD.putResult, { params: { widget_id: ids.gap }, body: g });

  // News: one article read, one page blocked (its box killed).
  const n = sampleResult(ids.news, account_id, 'pass');
  const read = n.result.sources[0]!;
  const bad = newId('cnd');
  const killedAt = new Date(Date.now() - 60_000).toISOString();
  n.result.sources.push({ candidate_id: bad, url: 'https://extra.fixture.test/nfl/injury-roundup.html', domain: 'extra.fixture.test', outlet: TRAP, published_at: null, status: 'blocked' });
  n.result.blocked = [{ candidate_id: bad, domain: 'extra.fixture.test', reason: 'poison', note: POISONED_NOTE, killed_at: killedAt, audit_row_id: null }];
  const base = n.trace[0]!;
  const st = (seq: number, s: Partial<RunTraceStep>): RunTraceStep => ({ ...base, seq, verdict_id: null, receipt_ids: [], duration_ms: 900, ...s });
  n.trace = [
    st(0, { step: 'read', status: 'ok', at: killedAt, sandbox: { sandbox_id: 'sbx_safety02', state: 'destroyed' }, source: { candidate_id: read.candidate_id, url: read.url, domain: read.domain, screenshot_key: null }, proxy: { allowed: 3, refused: 0 } }),
    st(1, { step: 'read', status: 'poisoned', at: killedAt, sandbox: { sandbox_id: 'sbx_safety03', state: 'killed' }, source: { candidate_id: bad, url: 'https://extra.fixture.test/nfl/injury-roundup.html', domain: 'extra.fixture.test', screenshot_key: null }, proxy: { allowed: 1, refused: 4 } }),
    st(2, { step: 'guard', status: 'ok', verdict_id: n.verdict.verdict_id }),
    { ...base, seq: 3 },
  ];
  await board(BOARD.putResult, { params: { widget_id: ids.news }, body: n });
}

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  // A sign-up, not a guest: the web files share one address, and edge allows 5 guests an hour from it.
  await page.goto(URL0);
  const status = await page.evaluate(
    (email) => fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'safety-test-pass-1' }) }).then((r) => r.status),
    `safety-${Date.now()}@example.com`,
  );
  expect(status).toBe(201);
  await page.reload();
  await ready(page);
  const { me, b } = await page.evaluate(async () => ({
    me: (await (await fetch('/api/me')).json()) as { account_id: string },
    b: (await (await fetch('/api/board')).json()) as { widgets: { spec: { widget_id: string; title: string; type?: string; place: object } }[] },
  }));
  const grid = b.widgets.map((w) => w.spec).filter((s) => !('folder_id' in s.place));
  const gap = grid.find((s) => s.type === 'gap')!;
  const news = grid.find((s) => s.type === 'news')!;
  expect(gap && news, JSON.stringify(grid.map((s) => s.type))).toBeTruthy();
  T.gap = plain(gap.title);
  T.news = news.title;
  await seed(me.account_id, { gap: gap.widget_id, news: news.widget_id });
  // audit reads the log stream on its own clock: wait until it has counted the rows.
  let seen = 0;
  let counts = { sandboxes_created: 0, articles_read: 0, proxy_refused: 0 };
  for (let t = 0; t < 60 && seen !== 8; t++) {
    if (t) await page.waitForTimeout(500);
    const tr = await page.evaluate(() => fetch('/api/trust').then((r) => r.json() as Promise<{ counts: { sandboxes_created: number; articles_read: number; proxy_refused: number } }>));
    counts = tr.counts;
    seen = tr.counts.sandboxes_created + tr.counts.proxy_refused;
  }
  expect(seen, 'audit counted the seeded rows').toBe(8);
  // 4 sealed boxes, but only the 3 browse boxes are articles: the compute box is the math step's.
  expect(counts).toMatchObject({ sandboxes_created: 4, articles_read: 3 });
  await page.reload();
  await ready(page);
  await settled(page);
});
afterAll(async () => {
  await browser?.close();
});

describe('Safety and How we got this at phone size', () => {
  it('the apps show their plain names', async () => {
    const names = await page.locator('#board > .w--app .a-label').allInnerTexts();
    expect(names).toEqual(['Safety', 'How we got it', 'Accounts', 'Add', 'Settings']);
  });

  it("Safety shows today's numbers in words, the blocked trick, spend per job, and Check it says Verified", async () => {
    await tile('Safety').tap();
    await sheet().waitFor();
    await settled(page);
    const stat = (k: string) => sheet().locator(`[data-stat="${k}"]`).innerText();
    expect((await stat('read')).replace(/\s+/g, ' ')).toBe('3 articles read in sealed boxes');
    expect((await stat('destroyed')).replace(/\s+/g, ' ')).toBe('3 sealed boxes destroyed after use');
    expect((await stat('stopped')).replace(/\s+/g, ' ')).toBe('4 requests stopped at the door');
    expect((await stat('tricks')).replace(/\s+/g, ' ')).toBe('1 trick blocked');
    const text = await sheet().innerText();
    expect(text).toContain('extra.fixture.test');
    expect(text).toContain(`This page had text aimed at the agent while it worked on ${T.news}. Its sealed box was destroyed.`);
    expect(text).toContain('No accounts connected');
    for (const job of ['Talking with you', 'Planning the research', 'Reading articles', 'Writing the short line', 'The safety check']) expect(text).toContain(job);
    expect(text).toMatch(/Total, of a \$\d+\.\d\d daily limit/);
    await shot(page, 'safety');
    const check = sheet().locator('#sf-check');
    await check.scrollIntoViewIfNeeded();
    await check.tap();
    await expect.poll(() => check.innerText(), { timeout: 15_000 }).toBe('Verified');
    const res = await sheet().locator('#sf-result').innerText();
    expect(res).toMatch(/^Verified\. All \d+ entries are unchanged and the signature matches\.$/);
    expect(Number(/All (\d+)/.exec(res)![1])).toBeGreaterThanOrEqual(9);
    await shot(page, 'safety-verified');
    await page.keyboard.press('Escape');
    await settled(page);
  });

  it('a tap on a number opens How we got this: prices, no articles, the math and its engine, the safety check; Details shows the receipt', async () => {
    await tile(T.gap).locator('.num').first().tap();
    await sheet().waitFor();
    await settled(page);
    const text = await sheet().innerText();
    expect(text).toContain('How we got this');
    for (const s of ['Where the prices came from', 'What we read', 'The math', 'The safety check']) expect(text).toContain(s);
    expect(text).toContain('No articles: this one is math on the prices only.');
    expect(text).toContain('The chance, from the price');
    expect(text).toContain('How far apart the two exchanges are');
    expect(text).toContain('Worked out by our math engine (version 0.1.0), never by the AI.');
    expect(text).not.toContain('r-0a1b2c3d');
    await shot(page, 'how-numbers');
    const toggle = sheet().locator('#how-toggle');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.tap();
    await expect.poll(() => sheet().locator('#how-details').isVisible()).toBe(true);
    const det = await sheet().locator('#how-details').innerText();
    expect(det).toContain('r-0a1b2c3d');
    expect(det).toContain('p = price_cents / 100');
    await shot(page, 'how-numbers-details');
    await page.keyboard.press('Escape');
    await settled(page);
  });

  it('from the ⋯ menu on a widget with a blocked read: the read article, the blocked site and time, and never a quote', async () => {
    await tile(T.news).locator('.w-menu-btn').tap();
    await page.locator('.surface.menu.is-open').waitFor();
    await settled(page);
    const row = page.locator('.surface.menu.is-open .m-main .mi', { hasText: 'How we got this' });
    expect(await row.getAttribute('aria-disabled')).toBeNull();
    await row.tap();
    await sheet().waitFor();
    await settled(page);
    const text = await sheet().innerText();
    expect(text).toContain('Sports Wire was read in a sealed box');
    expect(text).toMatch(/Blocked: a page on extra\.fixture\.test had text aimed at the agent\. Its sealed box was destroyed at .+\. Nothing from it was used\./);
    // Never a quote: not the facts' quotes, not the blocked page's outlet line, not its note.
    expect(text).not.toContain('listed as questionable');
    expect(text).not.toContain(TRAP);
    expect(text).not.toContain('give the agent orders');
    await shot(page, 'how-blocked');
    await page.keyboard.press('Escape');
    await settled(page);
    // /api/me's 401 for a signed-out visitor at boot is expected (Chromium logs it as a failed load).
    expect(problems.filter((p) => !/status of 401 .* @ http:\/\/[^/]+\/api\/me$/.test(p))).toEqual([]);
  });
});
