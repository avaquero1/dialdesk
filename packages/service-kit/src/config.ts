import { z } from 'zod';
import { PORTS, type ServiceName } from '@app/contracts';

/**
 * Config from env. Every variable a service reads starts with its name in upper case (BOARD_PORT, BOARD_CALLERS…),
 * so one dev `.env` can hold all of them and a production container gets only its own.
 *
 *   <SVC>_PORT              port to listen on (default: PORTS[svc])
 *   <SVC>_HOST              address to listen on (default 127.0.0.1; 0.0.0.0 inside a container)
 *   <SVC>_FAKE=1            serve the in-memory fake instead of the real handlers
 *   <SVC>_CALLERS           who may call it: "edge:<sha256 hex of edge's token>,agent:<hex>"
 *   <SVC>_TOKEN_<CALLEE>    the token this service presents to CALLEE (e.g. RUNNER_TOKEN_MARKETS)
 *   <SVC>_URL_<CALLEE>      CALLEE's base URL (default http://127.0.0.1:PORTS[callee])
 *   <SVC>_DATABASE_URL      its own database user (services that store data)
 *   <SVC>_VALKEY_URL        its own Valkey ACL user
 *   LOG_LEVEL               pino level (shared)
 */
export const BaseConfig = z.object({
  PORT: z.coerce.number().int().min(1).max(65535),
  HOST: z.string().min(1).default('127.0.0.1'),
  FAKE: z
    .enum(['0', '1', ''])
    .default('')
    .transform((v) => v === '1'),
  CALLERS: z.string().default(''),
  DATABASE_URL: z.string().optional(),
  VALKEY_URL: z.string().optional(),
});
export type BaseConfig = z.infer<typeof BaseConfig>;

export function envKey(service: string, name: string): string {
  return `${service.toUpperCase().replace(/-/g, '_')}_${name}`;
}

/** Reads `<SVC>_*` variables, strips the prefix, validates with BaseConfig extended by `extra`. Exits on bad config. */
export function loadConfig<X extends z.ZodRawShape>(service: ServiceName, extra?: X, env: NodeJS.ProcessEnv = process.env) {
  const prefix = envKey(service, '');
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (k.startsWith(prefix) && v !== undefined) raw[k.slice(prefix.length)] = v;
  raw.PORT ??= String(PORTS[service]);
  const schema = BaseConfig.extend(extra ?? ({} as X)).passthrough();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${prefix}${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`bad config for ${service}: ${fields}`);
  }
  return parsed.data as z.infer<typeof schema> & Record<string, string>;
}

/** The token this service presents to `callee`, and the callee's base URL. */
export function calleeConfig(service: ServiceName, callee: string, env: NodeJS.ProcessEnv = process.env) {
  const tag = callee.toUpperCase().replace(/-/g, '_');
  const token = env[envKey(service, `TOKEN_${tag}`)];
  const url = env[envKey(service, `URL_${tag}`)] ?? `http://127.0.0.1:${PORTS[callee as keyof typeof PORTS]}`;
  return { token, url };
}
