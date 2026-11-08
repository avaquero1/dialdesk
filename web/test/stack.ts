/**
 * This worktree's local web stack, as web/dev/stack.sh runs it: the main checkout on today's ports (8490, 1848x), any
 * other worktree on its own offset (`web/dev/stack.sh ports`), so a browser test always talks to its own worktree's stack.
 * WEB_URL still overrides the page's address.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ports: Record<string, string> = {};
for (const l of execFileSync(join(import.meta.dirname, '../dev/stack.sh'), ['ports'], { encoding: 'utf8' }).split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) ports[m[1]!] = m[2]!;
}

/** The page's address (Caddy). */
export const WEB_URL = process.env.WEB_URL ?? ports.WEB_URL!;

/** A service's address on the stack, e.g. stackService('board'). */
export const stackService = (name: string) => `http://127.0.0.1:${ports[`WEB_${name.toUpperCase()}_PORT`]!}`;

/** The repo's .env, with the stack's ports for a test that plays the runner (its Valkey user and its board address). */
export function stackEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const l of readFileSync(join(import.meta.dirname, '../../.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  env.RUNNER_VALKEY_URL = env.RUNNER_VALKEY_URL!.replace('127.0.0.1:56379', `127.0.0.1:${ports.WEB_VALKEY_PORT!}`);
  env.RUNNER_URL_BOARD = stackService('board');
  return env;
}
