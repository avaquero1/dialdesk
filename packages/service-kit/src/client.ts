import { z } from 'zod';
import { ApiError, fillPath, type Endpoint, type Input, type Output } from '@app/contracts';

export class CallError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
    readonly endpoint: string,
  ) {
    super(`${endpoint} -> ${status} ${body.error}: ${body.message}`);
  }
}

/** Thrown before sending when a request doesn't match the contract, or after when a response doesn't. */
export class ContractError extends Error {}

export interface ClientOptions {
  baseUrl: string;
  /** This caller's token for the callee. Omit only for public endpoints. */
  token?: string;
  /** Inject fetch, e.g. `(req) => fakeApp.fetch(req)` to call an in-process fake. */
  fetch?: (req: Request) => Response | Promise<Response>;
  headers?: Record<string, string>;
}

/**
 * A typed client for one callee. Requests are validated against packages/contracts before they're sent and
 * responses after they arrive, so a caller can't drift from the contract either.
 */
export function createClient(opts: ClientOptions) {
  const doFetch = opts.fetch ?? ((req: Request) => fetch(req));
  return async function call<E extends Endpoint>(e: E, input: Input<E>): Promise<Output<E>> {
    const label = `${e.service}.${e.name}`;
    const inp = input as { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
    for (const [part, schema] of [
      ['params', e.params],
      ['query', e.query],
      ['body', e.body],
    ] as const) {
      if (schema) {
        const r = (schema as z.ZodType).safeParse(inp[part]);
        if (!r.success) throw new ContractError(`${label} request ${part}: ${r.error.issues[0]?.message ?? 'invalid'}`);
      }
    }
    const url = new URL(fillPath(e.path, inp.params), opts.baseUrl);
    for (const [k, v] of Object.entries(inp.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (e.body) headers['content-type'] = 'application/json';
    const res = await doFetch(new Request(url, { method: e.method, headers, body: e.body ? JSON.stringify(inp.body) : undefined }));
    const json: unknown = await res.json().catch(() => ({}));
    if (res.status !== e.status) {
      const err = ApiError.safeParse(json);
      throw new CallError(res.status, err.success ? err.data : { error: 'bad_error_body', message: String(res.status) }, label);
    }
    const r = e.response.safeParse(json);
    if (!r.success) throw new ContractError(`${label} response: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
    return r.data as Output<E>;
  };
}
export type Call = ReturnType<typeof createClient>;

/** A client from this service's env: <SVC>_URL_<CALLEE> and <SVC>_TOKEN_<CALLEE>. */
export async function clientFromEnv(service: string, callee: string, env: NodeJS.ProcessEnv = process.env) {
  const { calleeConfig } = await import('./config.ts');
  const { url, token } = calleeConfig(service as never, callee, env);
  return createClient({ baseUrl: url, token });
}
