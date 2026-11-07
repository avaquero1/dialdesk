/**
 * Outbound HTTP for markets: the exchanges' public APIs, the catalog's feeds and Brave Search. Nothing else.
 * Every call has a timeout and a size cap. Answers are untrusted data: callers parse them with a schema.
 */
export type Fetch = typeof fetch;

export class UpstreamError extends Error {
  constructor(
    readonly host: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

export interface GetOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface Got {
  status: number;
  headers: Headers;
  text: string;
  url: string;
}

const USER_AGENT = 'vultr-hackathon-app-markets/0.1 (+public market data reader)';

export function httpGet(fetchImpl: Fetch = fetch) {
  return async function get(url: string, opts: GetOpts = {}): Promise<Got> {
    const host = new URL(url).hostname;
    const timeoutMs = opts.timeoutMs ?? 8000;
    const maxBytes = opts.maxBytes ?? 4_000_000;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...opts.headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    } catch (err) {
      throw new UpstreamError(host, null, `${host}: ${(err as Error).name === 'TimeoutError' ? 'timed out' : 'unreachable'}`);
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new UpstreamError(host, res.status, `${host}: answer too large`);
    const text = await readCapped(res, maxBytes, host);
    return { status: res.status, headers: res.headers, text, url: res.url || url };
  };
}

async function readCapped(res: Response, maxBytes: number, host: string): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new UpstreamError(host, res.status, `${host}: answer too large`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type HttpGet = ReturnType<typeof httpGet>;

/** GET and parse JSON. 404 answers `null`; any other non-2xx throws. */
export async function getJson(get: HttpGet, url: string, opts?: GetOpts): Promise<unknown> {
  const r = await get(url, opts);
  const host = new URL(url).hostname;
  if (r.status === 404) return null;
  if (r.status < 200 || r.status > 299) throw new UpstreamError(host, r.status, `${host}: status ${r.status}`);
  try {
    return JSON.parse(r.text) as unknown;
  } catch {
    throw new UpstreamError(host, r.status, `${host}: answer is not JSON`);
  }
}
