import { z } from 'zod';
import type { Caller, ServiceName } from './common.ts';

type Obj = z.ZodObject<z.ZodRawShape>;

/** One HTTP endpoint of a service. The service template serves it, the client calls it, the contract test checks both. */
export interface Endpoint<
  P extends Obj | undefined = Obj | undefined,
  Q extends Obj | undefined = Obj | undefined,
  B extends z.ZodType | undefined = z.ZodType | undefined,
  R extends z.ZodType = z.ZodType,
> {
  service: ServiceName;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Hono-style path: /widgets/:widget_id */
  path: string;
  /** Who may call it. The token check refuses everyone else. `browser` = a session through edge; `public` = no session. */
  callers: readonly Caller[];
  params: P;
  query: Q;
  body: B;
  response: R;
  /** The success status. */
  status: 200 | 201 | 202;
  /** Error statuses it may answer, each with an ApiError body. */
  errors: readonly number[];
  summary: string;
}

type Def<P, Q, B, R> = {
  method: Endpoint['method'];
  path: string;
  callers: readonly Caller[];
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  status?: 200 | 201 | 202;
  errors?: readonly number[];
  summary: string;
};

/** Builds a service's endpoint table: `const ACCOUNTS = api('accounts', { signup: {...}, ... })`. */
export function api<
  S extends ServiceName,
  T extends Record<string, Def<Obj | undefined, Obj | undefined, z.ZodType | undefined, z.ZodType>>,
>(service: S, defs: T) {
  const out = {} as {
    [K in keyof T]: Endpoint<
      T[K]['params'] extends Obj ? T[K]['params'] : undefined,
      T[K]['query'] extends Obj ? T[K]['query'] : undefined,
      T[K]['body'] extends z.ZodType ? T[K]['body'] : undefined,
      T[K]['response']
    >;
  };
  for (const [name, d] of Object.entries(defs)) {
    (out as Record<string, Endpoint>)[name] = {
      service,
      name,
      method: d.method,
      path: d.path,
      callers: d.callers,
      params: d.params,
      query: d.query,
      body: d.body,
      response: d.response,
      status: d.status ?? 200,
      errors: d.errors ?? [],
      summary: d.summary,
    } as Endpoint;
  }
  return out;
}

export type Input<E extends Endpoint> = (E['params'] extends Obj ? { params: z.input<E['params']> } : { params?: undefined }) &
  (E['query'] extends Obj ? { query: z.input<E['query']> } : { query?: undefined }) &
  (E['body'] extends z.ZodType ? { body: z.input<E['body']> } : { body?: undefined });

export type Output<E extends Endpoint> = z.output<E['response']>;

/** Fills a Hono-style path with params. */
export function fillPath(path: string, params: Record<string, unknown> | undefined): string {
  return path.replace(/:([a-z_]+)/g, (_, k: string) => {
    const v = params?.[k];
    if (v === undefined) throw new Error(`missing path param ${k} for ${path}`);
    return encodeURIComponent(String(v));
  });
}
