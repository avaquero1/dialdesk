/**
 * The Accounts app, the "Your account" display and Safety's consents at phone size, in a real browser on the local
 * stack (web/dev/stack.sh up; `make web-e2e`). connections is its fake there: it opens no sealed key and calls no
 * exchange, and a Kalshi key id containing "write" is refused as a key that can trade.
 *
 * The private key is a throwaway Ed25519 key made here, never a real one. The test checks that it leaves the page
 * only sealed: not in the request body, not in the field after sending, not in local or session storage.
 *
 *   WEB_URL (default: this worktree's stack, web/test/stack.ts)   CHROMIUM (default /usr/bin/chromium)   SHOTS_DIR (default web/test/.shots)
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_URL } from './stack.ts';

const URL0 = WEB_URL;
const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, '.shots');
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => page.screenshot({ path: join(SHOTS, `accounts-phone-${name}.png`) });

const PEM = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
/** A piece of the key's body: if it shows up anywhere, the key leaked. */
const KEY_BITS = PEM.split('\n')[1]!.slice(8, 40);
const WALLET = '0xAbC1230000000000000000000000000000007890';

let browser: Browser;
let page: Page;
const problems: string[] = [];
const sent: string[] = [];
let accountTitle = '';

const ready = (p: Page) => p.waitForFunction(() => window.__ready === true && document.documentElement.dataset.view === 'board', null, { timeout: 90_000 });
const settled = () =>
  page.waitForFunction(
    () => !document.querySelector('.surface.is-closing, #board > .w.is-new') && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'),
    null,
    { timeout: 30_000, polling: 100 },
  );
const tile = (title: string) => page.locator(`#board > .w:not(.is-out)[aria-label="${title}"]`);
/** The display's name on screen (W1.2.1): the catalog's inside titles in plain words. */
const plain = (t: string) => ({ Gap: 'Two prices', Positions: 'Your account', Movement: 'Biggest move' } as Record<string, string>)[t] ?? t;
const sheet = () => page.locator('.surface.sheet.is-open');
const close = async () => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.surface'), null, { timeout: 10_000 });
};
const openAccounts = async () => {
  await tile('Accounts').tap();
  await sheet().locator('#ac-promise').waitFor();
  await settled();
};

async function fillKalshi(key_id: string) {
  await sheet().locator('input[name="key_id"]').fill(key_id);
  await sheet().locator('textarea[name="pem"]').fill(PEM);
  await sheet().locator('input[name="demo"]').check();
  await sheet().locator('#ac-kalshi .ac-go').tap();
}

async function noKeyInPage() {
  const where = await page.evaluate((bits) => {
    const st = (s: Storage) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`).join('\n');
    const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].map((x) => x.value).join('\n');
    return { local: st(localStorage).includes(bits), session: st(sessionStorage).includes(bits), dom: document.documentElement.outerHTML.includes(bits), fields: fields.includes(bits) };
  }, KEY_BITS);
  expect(where).toEqual({ local: false, session: false, dom: false, fields: false });
}

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 403/.test(m.text())) problems.push(`console: ${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    if (r.url().endsWith('/api/connections') && r.method() === 'POST') sent.push(r.postData() ?? '');
  });
  // A sign-up by email, not a guest: the web files share one address, and edge allows 5 guests an hour from it.
  await page.goto(URL0);
  const status = await page.evaluate(
    (email) => fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'accounts-test-pass-1' }) }).then((r) => r.status),
    `accounts-${Date.now()}@example.com`,
  );
  expect(status).toBe(201);
  await page.reload();
  await ready(page);
  await settled();
  const b = await page.evaluate(async () => (await (await fetch('/api/board')).json()) as { widgets: { spec: { title: string; type?: string; place: object } }[] });
  const pos = b.widgets.map((w) => w.spec).find((s) => s.type === 'positions' && !('folder_id' in s.place));
  expect(pos, 'the first board has a Your account display').toBeTruthy();
  accountTitle = plain(pos!.title);
});
afterAll(async () => {
  await browser?.close();
});

describe('Accounts at phone size', () => {
  it('Your account says Not connected, and a tap opens Accounts with the promise before anything is pasted', async () => {
    const t = tile(accountTitle);
    await expect.poll(() => t.innerText()).toContain('Not connected');
    await t.scrollIntoViewIfNeeded();
    await shot('board-not-connected');
    await t.locator('[data-open-accounts]').tap();
    await sheet().locator('#ac-promise').waitFor();
    await settled();
    // The promise is the first thing under the title, above every field.
    const order = await sheet().evaluate((s) => {
      const p = s.querySelector('#ac-promise')!;
      const f = s.querySelector('input, textarea')!;
      return !!(p.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);
    expect(await sheet().locator('#ac-promise').innerText()).toBe('Read only. We can see your balance and positions. We can never trade or move money.');
    await sheet().locator('.ac-help summary').tap();
    const help = await sheet().locator('.ac-help').innerText();
    expect(help).toContain('kalshi.com');
    expect(help).toContain('allow only "Read"');
    // No link anywhere in the sheet but Kalshi's own site (and none at all today).
    const hrefs = await sheet().locator('a[href]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).hostname));
    expect(hrefs.every((h) => h === 'kalshi.com' || h.endsWith('.kalshi.com'))).toBe(true);
    await shot('accounts-open');
  });

  it('a key that can trade is refused with its plain reason, and the key is gone from the page', async () => {
    await fillKalshi('kalshi-write-key-0001');
    await expect.poll(() => sheet().locator('#ac-err').innerText()).toContain('This key can trade, so we did not keep it');
    expect(await sheet().locator('.ac-conn').count()).toBe(0);
    expect(await sheet().locator('textarea[name="pem"]').inputValue()).toBe('');
    await noKeyInPage();
    await shot('accounts-refused');
  });

  it('a read-only Kalshi key connects: "Read only, checked with Kalshi at <time>", and only a sealed key was sent', async () => {
    await fillKalshi('kalshi-read-key-0001');
    const row = sheet().locator('.ac-conn').first();
    await row.waitFor();
    await settled();
    const text = await row.innerText();
    expect(text).toContain('Kalshi · key kalshi-read-');
    expect(text).toMatch(/Read only, checked with Kalshi at \d{1,2}:\d\d/);
    await noKeyInPage();
    expect(sent.length).toBe(2);
    for (const body of sent) {
      expect(body).not.toContain('PRIVATE KEY');
      expect(body).not.toContain(KEY_BITS);
      const j = JSON.parse(body) as Record<string, unknown>;
      expect(Object.keys(j).sort()).toEqual(['env', 'exchange', 'key_id', 'key_type', 'sealed_key']);
      expect(j).toMatchObject({ exchange: 'kalshi', key_type: 'ed25519', env: 'demo' });
    }
    // The consent to let widgets use its numbers.
    const share = row.locator('[data-share]');
    await share.tap();
    await expect.poll(() => share.getAttribute('aria-pressed')).toBe('true');
    // Sharing links the account to the board's one Your account display (D1.3.1): board checked both are this account's.
    await expect.poll(() => row.locator('.ac-shown').innerText().catch(() => '')).toContain(`Shown on ${accountTitle}.`);
    const linked = await page.evaluate(async () => {
      const b = (await (await fetch('/api/board')).json()) as { widgets: { spec: { type?: string; params?: { connection_id?: string } } }[] };
      const c = (await (await fetch('/api/connections')).json()) as { connections: { connection_id: string }[] };
      return { on: b.widgets.find((w) => w.spec.type === 'positions')?.spec.params?.connection_id, con: c.connections[0]?.connection_id };
    });
    expect(linked.on).toBe(linked.con);
    await settled();
    await page.waitForTimeout(400);
    await shot('accounts-kalshi-connected');
  });

  it('a Polymarket wallet connects by its public address, no key', async () => {
    await sheet().locator('[data-tab="polymarket"]').tap();
    await sheet().locator('input[name="wallet"]').fill('0x123');
    await sheet().locator('#ac-poly .ac-go').tap();
    await expect.poll(() => sheet().locator('#ac-err').innerText()).toContain('starts with 0x and has 40');
    await sheet().locator('input[name="wallet"]').fill(WALLET);
    await sheet().locator('#ac-poly .ac-go').tap();
    await expect.poll(() => sheet().locator('.ac-conn').count()).toBe(2);
    await settled();
    const text = await sheet().locator('.ac-conn').nth(1).innerText();
    expect(text).toContain('Polymarket · 0xAbC1…7890');
    expect(text).toContain('Public wallet, read only');
    expect(JSON.parse(sent.at(-1)!)).toEqual({ exchange: 'polymarket', wallet: WALLET });
    await shot('accounts-both-connected');
    await close();
  });

  it('Your account shows the connected account, read only', async () => {
    await settled();
    const text = await tile(accountTitle).innerText();
    expect(text).toContain('Kalshi');
    expect(text).toContain('read only');
    expect(text).toMatch(/Checked with Kalshi at \d{1,2}:\d\d/);
    // The web stack's runner is a fake, so no run reads the numbers here (e2e/milestone-d1-3.test.ts runs one).
    expect(text).toContain('Reading the balance and positions');
    await tile(accountTitle).scrollIntoViewIfNeeded();
    await shot('board-connected');
  });

  it('Safety lists every consent: each account connected, when, its scope, and the numbers shared', async () => {
    await tile('Safety').tap();
    await sheet().locator('.sf-consent').first().waitFor();
    await settled();
    const consents = await sheet().locator('.sf-consent').allInnerTexts();
    const all = consents.join('\n');
    expect(all).toContain('You connected Kalshi (key kalshi-read-)');
    expect(all).toContain('You connected your Polymarket wallet 0xAbC1…7890');
    expect(all).toContain('Read only: we can see your balance and positions, never trade or move money.');
    expect(all).toContain("You let your widgets use Kalshi's numbers");
    expect(all).toMatch(/[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d/);
    const text = await sheet().innerText();
    expect(text).toMatch(/Read only, checked with Kalshi at \d{1,2}:\d\d/);
    await sheet().locator('.sf-h', { hasText: 'Connected accounts' }).evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await shot('safety-consents');
    await close();
  });

  it('Disconnect removes the account and its key', async () => {
    await openAccounts();
    await sheet().locator('.ac-conn').nth(1).locator('[data-disconnect]').tap();
    await expect.poll(() => sheet().locator('.ac-conn').count()).toBe(1);
    await sheet().locator('.ac-conn').first().locator('[data-disconnect]').tap();
    await expect.poll(() => sheet().locator('.ac-conn').count()).toBe(0);
    const list = await page.evaluate(() => fetch('/api/connections').then((r) => r.json() as Promise<{ connections: unknown[] }>));
    expect(list.connections).toEqual([]);
    await settled();
    await shot('accounts-disconnected');
    await close();
    await expect.poll(() => tile(accountTitle).innerText()).toContain('Not connected');
  });

  it('no console errors', () => {
    // /api/me's 401 for a signed-out visitor at boot is expected (Chromium logs it as a failed load).
    expect(problems.filter((p) => !/status of 401 .* @ http:\/\/[^/]+\/api\/me$/.test(p))).toEqual([]);
  });
});
