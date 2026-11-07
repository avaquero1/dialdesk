/**
 * DOM helpers. The Content-Security-Policy forbids inline styles and scripts, so markup never carries a `style`
 * attribute: an element that needs inline values gets `data-css="--i:2;left:40%"`, and `hydrate()` applies it
 * through the CSSOM, which the policy allows. Text from the server always goes through `esc()`.
 */
export const root = document.documentElement;
export const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
export const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const raf2 = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes text for HTML. Every value from the server or the user passes through here. */
export const esc = (t: unknown) => String(t).replace(/[&<>"']/g, (c) => ESC[c]!);

/** `data-css` for an element: CSS declarations applied by hydrate(). Values are built by this app, never by the server. */
export const css = (decls: string) => ` data-css="${esc(decls)}"`;

/** Applies every `data-css` under (and on) `el` with style.setProperty, then drops the attribute. */
export function hydrate<T extends Element>(el: T): T {
  const all = (el as unknown as HTMLElement).dataset?.css !== undefined ? [el as unknown as HTMLElement] : [];
  all.push(...$$<HTMLElement>('[data-css]', el));
  for (const e of all) {
    for (const d of (e.dataset.css ?? '').split(';')) {
      const k = d.indexOf(':');
      if (k > 0) e.style.setProperty(d.slice(0, k).trim(), d.slice(k + 1).trim());
    }
    delete e.dataset.css;
  }
  return el;
}

/** Makes an element; `html` is markup built by this app (data inside it is already escaped). */
export function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) {
    e.innerHTML = html;
    hydrate(e);
  }
  return e;
}

/** Sets markup built by this app on an element, then applies its data-css. */
export function setHtml(e: Element, html: string) {
  e.innerHTML = html;
  hydrate(e);
}

export const cssNum = (n: string, d: number) => {
  const v = parseFloat(getComputedStyle(root).getPropertyValue(n));
  return Number.isFinite(v) ? v : d;
};

export const reduced = () => root.dataset.motion === 'reduced';

/** Finishes every finite animation now (used before reading rects in tests and when a surface must open at once). */
export function finishAnimations() {
  for (const a of document.getAnimations()) {
    try {
      if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
    } catch {
      /* an animation that can't finish is left alone */
    }
  }
}
