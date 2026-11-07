/* global process, setTimeout, URL, document, NodeFilter, Node */
// The browse sandbox's driver. It opens each URL in Chromium through the egress proxy, reads the page's text
// (hidden text and comments too, so the guard sees planted orders) and, if asked, takes a screenshot. It does
// nothing else: no forms, no logins, no downloads, no clicks. Then it holds the browser open until the manager
// releases or kills the sandbox (or --max-life passes).
//
// One JSON event per line on stdout, read by sandbox-manager:
//   {"ev":"launched","chromium":"…","sandbox":"on"|"off","fallback":bool}
//   {"ev":"page","url":"…","status":200,"text":"…","screenshot_png_b64":"…"|null,"error":null}
//   {"ev":"ready"}                       every page is read; the sandbox is now held
//   {"ev":"error","stage":"…","message":"…"}
//
//   node driver.mjs --proxy http://172.30.79.2:8201 --url https://… [--url …] [--screenshot]
//        [--output-kb 2048] [--sandbox off|on|auto] [--spki <base64 sha256>] [--max-life 120]
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const all = (k) => argv.flatMap((a, i) => (a === `--${k}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
const arg = (k, d) => all(k)[0] ?? d;
const flag = (k) => argv.includes(`--${k}`);

const urls = all('url');
const proxy = arg('proxy');
const sandboxMode = arg('sandbox', 'off');
const outputBytes = Number(arg('output-kb', '2048')) * 1024;
const maxLife = Number(arg('max-life', '120'));
const spki = arg('spki');
const chromePath = process.env.CHROME_BIN || '/usr/lib/chromium/chromium';

const emit = (o) => new Promise((res) => process.stdout.write(JSON.stringify(o) + '\n', res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String(e?.message || e).split('\n')[0].slice(0, 300);
process.on('SIGTERM', () => process.exit(0));
process.on('unhandledRejection', () => {});
// A hard stop of its own, beside the manager's: the sandbox never outlives max-life.
setTimeout(() => process.exit(0), maxLife * 1000).unref();

if (!proxy || urls.length === 0) {
  await emit({ ev: 'error', stage: 'args', message: 'need --proxy and at least one --url' });
  process.exit(2);
}

function chromeArgs(sandboxOn) {
  const proxyHost = new URL(proxy).hostname;
  const a = [
    `--proxy-server=${proxy}`,
    // Chromium skips the proxy for loopback and link-local (169.254/16) unless told not to: the page's call to
    // the metadata address would go direct, missing the proxy log, and only the network block would stop it.
    '--proxy-bypass-list=<-loopback>',
    // Chromium never resolves a name itself; the proxy does. The proxy's own address is excluded from the rule.
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${proxyHost}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1280,800',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--disable-breakpad', '--disable-component-update', '--disable-domain-reliability', '--no-pings',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,NetworkTimeServiceQuerying,CertificateTransparencyComponentUpdater',
  ];
  if (spki) a.push(`--ignore-certificate-errors-spki-list=${spki}`); // dev: trusts the fixture certificate only
  if (!sandboxOn) a.push('--no-sandbox');
  return a;
}

const launch = (sandboxOn) =>
  puppeteer.launch({
    executablePath: chromePath, headless: true, pipe: true, timeout: 20000, userDataDir: '/tmp/profile',
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: chromeArgs(sandboxOn),
  });

let browser;
let sandbox = 'off';
let fallback = false;
try {
  if (sandboxMode === 'off') browser = await launch(false);
  else {
    try {
      browser = await launch(true);
      sandbox = 'on';
    } catch (e) {
      if (sandboxMode === 'on') throw e;
      fallback = true;
      browser = await launch(false);
    }
  }
} catch (e) {
  await emit({ ev: 'error', stage: 'launch', message: short(e) });
  process.exit(3);
}
await emit({ ev: 'launched', chromium: await browser.version(), sandbox, fallback });

// Everything a page holds as text: visible, hidden, and HTML comments. Scripts and styles are left out.
function pageText() {
  const parts = [];
  const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement;
    if (n.nodeType === Node.TEXT_NODE && p && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
    parts.push(n.nodeValue);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

let budget = outputBytes - 4096;
const textCap = Math.max(1024, Math.floor(budget / urls.length / 2));
const pages = [];
for (const url of urls) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  let status = 0;
  let error = null;
  page.on('response', (r) => {
    if (status === 0 && r.request().isNavigationRequest() && r.frame() === page.mainFrame()) status = r.status();
  });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  } catch (e) {
    error = `navigate: ${short(e)}`;
  }
  await sleep(800); // the page's own scripts fire their calls out; the proxy logs them before "ready"
  let text = '';
  try {
    text = (await page.evaluate(pageText)).slice(0, textCap);
  } catch (e) {
    error = error || `extract: ${short(e)}`;
  }
  budget -= text.length * 2 + 512;
  let shot = null;
  if (flag('screenshot') && !error) {
    try {
      const b64 = await page.screenshot({ type: 'png', encoding: 'base64' });
      if (b64.length < budget) {
        shot = b64;
        budget -= b64.length;
      } else error = 'screenshot: over the output limit';
    } catch (e) {
      error = `screenshot: ${short(e)}`;
    }
  }
  await emit({ ev: 'page', url, status, text, screenshot_png_b64: shot, error });
  pages.push(page);
}
await emit({ ev: 'ready' });
// Held: the pages stay open until release (the sandbox is destroyed) or kill.
for (;;) await sleep(60000);
