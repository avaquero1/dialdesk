/**
 * The only way connections talks to an exchange: a fetch that sends GET and nothing else, to a hand-written list of
 * origins and paths. Every exchange client is built on it, so a bug elsewhere can't place an order, cancel one or move
 * money: a request with another method, a body, or an off-list URL throws before anything leaves the process.
 * `test/getonly.test.ts` proves it for every HTTP method.
 */
export interface Route {
  origin: string;
  /** Path prefix (e.g. /trade-api/v2) and the exact paths allowed under it. */
  base: string;
  paths: readonly string[];
}

export class NotAllowedRequest extends Error {
  constructor(reason: string) {
    super(`refused before sending: ${reason}`);
    this.name = 'NotAllowedRequest';
  }
}

export type GetOnlyFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export function getOnlyFetch(routes: readonly Route[], inner: typeof fetch = fetch): GetOnlyFetch {
  return (url, init = {}) => {
    // `init` is typed without method or body; this check holds against callers that cast around the type, too.
    const raw = init as RequestInit;
    const method = (raw.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return Promise.reject(new NotAllowedRequest(`method ${method}`));
    if (raw.body !== undefined && raw.body !== null) return Promise.reject(new NotAllowedRequest('a GET with a body'));
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return Promise.reject(new NotAllowedRequest('not a URL'));
    }
    if (u.username || u.password) return Promise.reject(new NotAllowedRequest('credentials in the URL'));
    const ok = routes.some((r) => u.origin === r.origin && r.paths.some((p) => u.pathname === r.base + p));
    if (!ok) return Promise.reject(new NotAllowedRequest(`${u.origin}${u.pathname} is not on the list`));
    return inner(u.toString(), { method: 'GET', headers: init.headers, signal: init.signal, redirect: 'error' });
  };
}
