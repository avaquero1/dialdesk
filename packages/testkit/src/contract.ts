import { ApiError, SERVICES, fillPath, type Caller, type Endpoint, type ServiceName } from '@app/contracts';
import { buildApp, createLogger, hashToken, type Handlers, type SessionCheck } from '@app/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

export type Ctx = Record<string, unknown> & { cookie?: string };
export type CaseInput = { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };

/** One request in a service's contract cases. Cases run in order and share `ctx`. */
export interface Case {
  endpoint: string;
  caller: Caller;
  input?: (ctx: Ctx) => CaseInput;
  /** Expected status; default the endpoint's success status. */
  expect?: number;
  save?: (out: any, ctx: Ctx) => void;
  label?: string;
  /** Runs first, e.g. to put state in place through a back door. */
  before?: (ctx: Ctx) => Promise<void>;
}

/** One token per service, the same in every test, so a case can call as any caller. */
export const TEST_TOKENS = Object.fromEntries(SERVICES.map((s) => [s, `test-token-for-${s}-0123456789abcdef`])) as Record<ServiceName, string>;
export const testCallers = () => new Map(SERVICES.map((s) => [s, Buffer.from(hashToken(TEST_TOKENS[s]), 'hex')]));

export function fakeApp<T extends Record<string, Endpoint>>(service: ServiceName, api: T, handlers: Handlers<T>, sessionCheck?: SessionCheck): Hono {
  return buildApp({ service, mode: 'fake', api, handlers, callers: testCallers(), log: createLogger(service, 'silent'), sessionCheck });
}

export interface Outcome {
  ok: boolean;
  problems: string[];
  status: number;
  body: unknown;
}

/**
 * Sends one case to the app and checks it against the contract: the request must match the endpoint's schemas,
 * the status must be the expected one, and the body must match the response schema (or ApiError).
 */
export async function runCase(app: Hono, api: Record<string, Endpoint>, c: Case, ctx: Ctx): Promise<Outcome> {
  const e = api[c.endpoint];
  if (!e) return { ok: false, problems: [`no endpoint ${c.endpoint} in the contract`], status: 0, body: null };
  const problems: string[] = [];
  await c.before?.(ctx);
  const input = c.input?.(ctx) ?? {};
  for (const [part, schema] of [
    ['params', e.params],
    ['query', e.query],
    ['body', e.body],
  ] as const) {
    if (!schema) continue;
    const r = (schema as z.ZodType).safeParse(input[part]);
    if (!r.success) problems.push(`request ${part} breaks the contract: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
  }
  const url = new URL(fillPath(e.path, input.params), 'http://test.internal');
  for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (c.caller === 'browser' && ctx.cookie) headers.cookie = ctx.cookie;
  else if (c.caller !== 'public' && c.caller !== 'browser') headers.authorization = `Bearer ${TEST_TOKENS[c.caller]}`;
  if (e.body) headers['content-type'] = 'application/json';
  const res = await app.request(url.pathname + url.search, { method: e.method, headers, body: e.body ? JSON.stringify(input.body) : undefined });
  const body: unknown = await res.json().catch(() => null);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) ctx.cookie = setCookie.split(';')[0];
  const want = c.expect ?? e.status;
  if (res.status !== want) problems.push(`status ${res.status}, want ${want}: ${JSON.stringify(body).slice(0, 300)}`);
  const schema = res.status === e.status ? e.response : ApiError;
  const r = (schema as z.ZodType).safeParse(body);
  if (!r.success) problems.push(`response breaks the contract: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).slice(0, 3).join('; ')}`);
  if (res.status !== e.status && res.status !== 401 && res.status !== 403 && !e.errors.includes(res.status) && res.status !== want)
    problems.push(`undeclared error status ${res.status}`);
  if (!problems.length && res.status === e.status) c.save?.(r.data, ctx);
  return { ok: problems.length === 0, problems, status: res.status, body };
}

/** A service caller that may not call `e`, to prove the token check refuses it. */
export function outsider(e: Endpoint): ServiceName | null {
  return SERVICES.find((s) => !e.callers.includes(s)) ?? null;
}
