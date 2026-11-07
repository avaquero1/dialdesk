import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ApiError, type Caller, type Endpoint, type ServiceName } from '@app/contracts';
import { identifyCaller } from './auth.ts';
import { CallError } from './client.ts';
import type { Logger } from './log.ts';

/** Throw from a handler to answer an error. The status must be in the endpoint's `errors`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

type Obj = z.ZodObject<z.ZodRawShape>;
export type HandlerInput<E extends Endpoint> = {
  params: E['params'] extends Obj ? z.output<E['params']> : Record<string, never>;
  query: E['query'] extends Obj ? z.output<E['query']> : Record<string, never>;
  body: E['body'] extends z.ZodType ? z.output<E['body']> : undefined;
};
export type HandlerCtx = {
  caller: Caller;
  /** Set for `browser` calls: the session's account. */
  accountId: string | null;
  sessionId: string | null;
  log: Logger;
  /** For edge: set a response header (the session cookie). */
  setHeader: (name: string, value: string) => void;
};
export type Handler<E extends Endpoint> = (input: HandlerInput<E>, ctx: HandlerCtx) => Promise<z.input<E['response']>> | z.input<E['response']>;
export type Handlers<T extends Record<string, Endpoint>> = { [K in keyof T]: Handler<T[K]> };

export type SessionCheck = (c: Context) => Promise<{ accountId: string; sessionId: string } | null>;

export interface AppOptions<T extends Record<string, Endpoint>> {
  service: ServiceName;
  version?: string;
  mode: 'real' | 'fake';
  api: T;
  /** Every endpoint must have a handler. Real mode may leave some unimplemented with `notImplemented`. */
  handlers: Handlers<T>;
  /** caller name -> sha256 of its token (from <SVC>_CALLERS). */
  callers: Map<string, Buffer>;
  log: Logger;
  /** Only edge serves `browser` routes; it passes its session check here. */
  sessionCheck?: SessionCheck;
  /** Validate responses against the contract (default: on unless NODE_ENV=production). */
  strictResponses?: boolean;
}

const jsonError = (c: Context, status: number, error: string, message: string) =>
  c.json(ApiError.parse({ error, message }), status as never);

function issues(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** A placeholder handler for real mode until a Phase 1 worker writes it. Answers 501. */
export function notImplemented(): never {
  throw new HttpError(501, 'not_implemented', 'not built yet (Phase 1)');
}

/**
 * The service template: /health, the per-caller token check, request validation and (outside production)
 * response validation against packages/contracts, structured logs. Each endpoint is served from its contract.
 */
export function buildApp<T extends Record<string, Endpoint>>(opts: AppOptions<T>): Hono {
  const app = new Hono();
  const strict = opts.strictResponses ?? process.env.NODE_ENV !== 'production';

  app.get('/health', (c) => c.json({ ok: true, service: opts.service, version: opts.version ?? '0.0.0', mode: opts.mode }));

  for (const [name, e] of Object.entries(opts.api) as [string, Endpoint][]) {
    const handler = opts.handlers[name] as Handler<Endpoint> | undefined;
    if (!handler) throw new Error(`${opts.service}: no handler for ${name}`);
    const method = e.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';

    app[method](e.path, async (c) => {
      const started = performance.now();
      // 1. Who is calling?
      let caller: Caller | null = null;
      let accountId: string | null = null;
      let sessionId: string | null = null;
      if (e.callers.includes('public')) caller = 'public';
      if (e.callers.includes('browser') && opts.sessionCheck) {
        const s = await opts.sessionCheck(c);
        if (s) {
          caller = 'browser';
          accountId = s.accountId;
          sessionId = s.sessionId;
        }
      }
      if (!caller) {
        const who = identifyCaller(c.req.header('authorization'), opts.callers);
        if (who && e.callers.includes(who)) caller = who;
        else if (who) return jsonError(c, 403, 'forbidden', `${who} may not call ${name}`);
      }
      if (!caller) return jsonError(c, 401, 'unauthorized', 'missing or unknown token');

      // 2. Validate the request against the contract.
      const params = e.params ? e.params.safeParse(c.req.param()) : { success: true as const, data: {} };
      if (!params.success) return jsonError(c, 400, 'bad_request', issues(params.error));
      const query = e.query ? e.query.safeParse(c.req.query()) : { success: true as const, data: {} };
      if (!query.success) return jsonError(c, 400, 'bad_request', issues(query.error));
      let body: unknown = undefined;
      if (e.body) {
        let raw: unknown;
        try {
          raw = await c.req.json();
        } catch {
          return jsonError(c, 400, 'bad_request', 'body is not JSON');
        }
        const parsed = e.body.safeParse(raw);
        if (!parsed.success) return jsonError(c, 400, 'bad_request', issues(parsed.error));
        body = parsed.data;
      }

      // 3. Run the handler.
      const headers: [string, string][] = [];
      let out: unknown;
      try {
        out = await handler(
          { params: params.data, query: query.data, body } as never,
          { caller, accountId, sessionId, log: opts.log, setHeader: (n, v) => headers.push([n, v]) },
        );
      } catch (err) {
        if (err instanceof HttpError) {
          if (err.status !== 501 && !e.errors.includes(err.status) && ![400, 401, 403].includes(err.status)) {
            opts.log.error({ endpoint: name, status: err.status }, 'contract violation: undeclared error status');
            if (strict) return jsonError(c, 500, 'contract_violation', `${name} answered undeclared status ${err.status}`);
          }
          return jsonError(c, err.status, err.code, err.message);
        }
        // An upstream's 4xx passes through (edge and the thin routers); anything else is ours.
        if (err instanceof CallError && err.status < 500 && (e.errors.includes(err.status) || err.status === 400))
          return jsonError(c, err.status, err.body.error, err.body.message);
        opts.log.error({ endpoint: name, err: (err as Error).message }, 'handler failed');
        return jsonError(c, 500, 'internal', 'internal error');
      }

      // 4. Check the response against the contract.
      if (strict) {
        const r = e.response.safeParse(out);
        if (!r.success) {
          opts.log.error({ endpoint: name, issues: issues(r.error) }, 'contract violation: response');
          return jsonError(c, 500, 'contract_violation', `${name} response: ${issues(r.error)}`);
        }
        out = r.data;
      }
      for (const [n, v] of headers) c.header(n, v);
      opts.log.info({ endpoint: name, caller, ms: Math.round(performance.now() - started) }, 'request');
      return c.json(out as object, e.status);
    });
  }

  app.notFound((c) => jsonError(c, 404, 'not_found', 'no such route'));
  return app;
}

/** Real handlers for a service nobody has built yet: every endpoint answers 501. */
export function unbuilt<T extends Record<string, Endpoint>>(api: T): Handlers<T> {
  return Object.fromEntries(Object.keys(api).map((k) => [k, notImplemented])) as unknown as Handlers<T>;
}
