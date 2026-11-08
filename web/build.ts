/**
 * Builds web/dist, the static bundle Caddy serves:
 *   dist/index.html                  no inline script, no inline style, no handler attributes
 *   dist/assets/app-<hash>.js        src/main.ts bundled (ES modules, minified)
 *   dist/assets/app-<hash>.css       the design kit's base + every theme + src/app.css + src/chat.css
 * System fonts only, and the page asks for nothing but its own two assets, /api and /live.
 *
 *   npx tsx web/build.ts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, transform } from 'esbuild';
import { DEFAULT_LOOK } from '@app/contracts';
import { BASE_CSS, listThemes, stripComments } from '@app/design-kit';

const HERE = import.meta.dirname;
const SRC = join(HERE, 'src');
const DIST = join(HERE, 'dist');
const out = (s: string) => process.stdout.write(s + '\n');
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);

/** Problems that would break the Content-Security-Policy or reach out to the network. */
export function checkHtml(html: string): string[] {
  const bad: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc=/.test(m[1]!) || m[2]!.trim()) bad.push('an inline script');
  }
  if (/<style\b/i.test(html)) bad.push('a <style> element');
  if (/\sstyle\s*=/i.test(html)) bad.push('a style attribute');
  if (/\son[a-z]+\s*=/i.test(html)) bad.push('an event handler attribute');
  if (/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html)) bad.push('an external URL');
  return bad;
}

export async function buildWeb() {
  const themes = listThemes();
  if (!themes.length) throw new Error('no themes in packages/design-kit/css/themes');

  const js = await build({
    entryPoints: [join(SRC, 'main.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120', 'firefox121', 'safari17'],
    minify: true,
    legalComments: 'none',
    write: false,
    define: { __THEMES__: JSON.stringify(themes.map(({ id, name }) => ({ id, name }))) },
    logLevel: 'warning',
  });
  const jsText = js.outputFiles[0]!.text;
  if (/\b(eval|new Function)\s*\(/.test(jsText)) throw new Error('the bundle uses eval or new Function (the policy forbids both)');

  const cssSrc = [
    stripComments(readFileSync(BASE_CSS, 'utf8')),
    ...themes.map((t) => `/* theme ${t.id} */\n` + stripComments(t.css)),
    stripComments(readFileSync(join(SRC, 'app.css'), 'utf8')),
    stripComments(readFileSync(join(SRC, 'chat.css'), 'utf8')),
  ].join('\n');
  const cssText = (await transform(cssSrc, { loader: 'css', minify: true, legalComments: 'none' })).code;

  const jsName = `app-${hash(jsText)}.js`;
  const cssName = `app-${hash(cssText)}.css`;
  let html = readFileSync(join(SRC, 'index.html'), 'utf8');
  const put = (k: string, v: string) => {
    if (!html.includes(k)) throw new Error(`index.html has no ${k}`);
    html = html.split(k).join(v);
  };
  put('@@JS@@', jsName);
  put('@@CSS@@', cssName);
  put('@@THEME0@@', DEFAULT_LOOK.theme);
  put('@@MODE0@@', DEFAULT_LOOK.mode === 'system' ? 'light' : DEFAULT_LOOK.mode);
  const bad = checkHtml(html);
  if (bad.length) throw new Error(`index.html breaks the policy: ${bad.join(', ')}`);

  // Empty dist without removing it: a server may have it mounted (web/dev/compose.yml).
  mkdirSync(DIST, { recursive: true });
  for (const f of readdirSync(DIST)) rmSync(join(DIST, f), { recursive: true, force: true });
  mkdirSync(join(DIST, 'assets'), { recursive: true });
  writeFileSync(join(DIST, 'index.html'), html);
  writeFileSync(join(DIST, 'assets', jsName), jsText);
  writeFileSync(join(DIST, 'assets', cssName), cssText);
  return { html, jsName, cssName, jsBytes: jsText.length, cssBytes: cssText.length, themes: themes.map((t) => t.id) };
}

if (import.meta.main) {
  const r = await buildWeb();
  out(`web/dist: ${r.jsName} ${(r.jsBytes / 1024).toFixed(1)} KB, ${r.cssName} ${(r.cssBytes / 1024).toFixed(1)} KB`);
  out(`themes: ${r.themes.join(', ')}`);
}
