/**
 * The real stack for `make e2e-real`: all nine services in real mode on this machine (tsx, against the worktree's .env),
 * on their own ports, beside (never on) vha-dev's or the web stack's. Only the model is faked (MODELS_FAKE=1).
 *
 *   Compose project vha-e2e-real (started by the Makefile): Postgres :55441, Valkey :56441, fixtures :8300 (the catalog's
 *   fixture rows name that port)
 *   edge :18440, accounts :18441, board :18442, agent :18443, runner :18444, markets :18445, connections :18446,
 *   models :18447 (fake), audit :18448; sandbox-manager on the docker backend, on its dev topology (sandbox/dev/topology.ts)
 *
 * markets runs from e2e/real/markets-recorded.ts: the real service on the recording of this weekend's games.
 * Logs: .logs/e2e-real/<service>.log.
 *
 * `stackUp({ live: true })` is `make e2e-live` (meeting point 2, its own Compose project and ports): models real on Vultr
 * (e2e/live/models-capped.ts, both caps at most $1.00 for the step), markets on the live exchanges and feeds
 * (e2e/live/markets-live.ts, plus our own poisoned test page for one team's game), the topology's proxy on the internet.
 * Logs: .logs/e2e-live/<service>.log.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { startManager, topologyUp, type Manager, type Topology } from '../../sandbox/dev/topology.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const SERVICES = ['edge', 'accounts', 'board', 'agent', 'runner', 'markets', 'connections', 'models', 'audit'] as const;
export type Svc = (typeof SERVICES)[number];
const BASE = Number(process.env.E2E_REAL_PORT_BASE ?? 18440);
export const PORT = Object.fromEntries(SERVICES.map((s, i) => [s, BASE + i])) as Record<Svc, number>;
export const PG_PORT = Number(process.env.E2E_REAL_PG_PORT ?? 55441);
export const VALKEY_PORT = Number(process.env.E2E_REAL_VALKEY_PORT ?? 56441);
export const ORIGIN = `http://localhost:${PORT.edge}`;
export interface StackOpts {
  /** Meeting point 2: real models, live markets and news, sandboxes that read live pages. */
  live?: boolean;
}

export interface Stack {
  env: Record<string, string>;
  manager: Manager;
  topo: Topology;
  url: (s: Svc) => string;
  /** The tail of a service's log, for a failing step's message. */
  log: (s: Svc) => string;
  /** Where the logs and the run's own files are (the cap self-test's result in live mode). */
  logs: string;
  scratch: string;
  down: () => Promise<void>;
}

/** The worktree's .env, re-pointed at this stack's ports. */
export function stackEnv(managerUrl: string, scratch: string, opts: StackOpts = {}): Record<string, string> {
  const env = parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')) as Record<string, string>;
  for (const s of SERVICES) {
    const S = s.toUpperCase();
    env[`${S}_PORT`] = String(PORT[s]);
    for (const c of SERVICES) env[`${S}_URL_${c.toUpperCase()}`] = `http://127.0.0.1:${PORT[c]}`;
    const db = env[`${S}_DATABASE_URL`];
    if (db) env[`${S}_DATABASE_URL`] = db.replace('@127.0.0.1:55432/', `@127.0.0.1:${PG_PORT}/`);
    const vk = env[`${S}_VALKEY_URL`];
    if (vk) env[`${S}_VALKEY_URL`] = vk.replace(/@127\.0\.0\.1:56379$/, `@127.0.0.1:${VALKEY_PORT}`);
    env[`${S}_FAKE`] = s === 'models' && !opts.live ? '1' : '0';
  }
  Object.assign(env, {
    RUNNER_URL_SANDBOX_MANAGER: managerUrl,
    RUNNER_SOURCE_ENV: 'fixture',
    // The scheduler's re-runs (every display, folder cards too, each 120 s) are not part of this journey and, on a loaded
    // box, crowd out the refresh's compute sandbox ("compute timed out"). e2e/flow.test.ts tests the scheduler itself.
    RUNNER_SCHEDULE_TICK_MS: '600000',
    MARKETS_SOURCE_ENV: 'fixture',
    MARKETS_BRAVE_KEY_FILE: '/nonexistent/brave-search',
    EDGE_ALLOWED_ORIGINS: ORIGIN,
    EDGE_HOST: '127.0.0.1',
    BOARD_SCREENSHOT_DIR: join(scratch, 'screenshots'),
    AUDIT_HEADS_DIR: join(scratch, 'audit-heads'),
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  });
  if (opts.live) {
    const brave = process.env.MARKETS_BRAVE_KEY_FILE;
    const need = (k: string) => process.env[k] || (() => { throw new Error(`e2e-live: set ${k}`); })();
    Object.assign(env, {
      MARKETS_SOURCE_ENV: 'prod',
      MARKETS_BRAVE_KEY_FILE: brave && existsSync(brave) ? brave : '/nonexistent/brave-search',
      // Our poisoned test page is a fixture row: runner keeps the fixture rows beside the prod ones.
      RUNNER_SOURCE_ENV: 'fixture',
      MODELS_DAILY_CAP_USD: need('E2E_LIVE_CAP_USD'),
      MODELS_ACCOUNT_DAILY_USD: need('E2E_LIVE_CAP_USD'),
      MODELS_ACCOUNT_DAILY_TOKENS: '3000000',
      MODELS_ACCOUNT_RPM: '60',
      E2E_LIVE_USAGE: need('E2E_LIVE_USAGE'),
      E2E_LIVE_SELFTEST: join(scratch, 'cap-self-test.json'),
      E2E_LIVE_POISON_TEAM: need('E2E_LIVE_POISON_TEAM'),
    });
  }
  return env;
}

const health = (url: string) => fetch(`${url}/health`).then((r) => r.ok, () => false);

const LAUNCHERS: Partial<Record<Svc, string>> = { markets: 'e2e/real/markets-recorded.ts' };
const LIVE_LAUNCHERS: Partial<Record<Svc, string>> = { markets: 'e2e/live/markets-live.ts', models: 'e2e/live/models-capped.ts' };

export async function stackUp(opts: StackOpts = {}): Promise<Stack> {
  const kind = opts.live ? 'e2e-live' : 'e2e-real';
  const LOGS = join(ROOT, '.logs', kind);
  mkdirSync(LOGS, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), `vha-${kind}-`));
  const topo = topologyUp(`vha-${opts.live ? 'e2el' : 'e2er'}${process.pid}`, { internet: opts.live });
  const procs: ChildProcess[] = [];
  let manager: Manager | undefined;
  const down = async () => {
    for (const p of procs) p.kill('SIGTERM');
    await Promise.all(procs.map((p) => (p.exitCode === null && p.signalCode === null ? new Promise((r) => p.once('exit', r)) : null)));
    manager?.stop();
    topo.down();
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const env0 = parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')) as Record<string, string>;
    manager = await startManager(topo, env0.SANDBOX_MANAGER_CALLERS!);
    const env = stackEnv(manager.url, scratch, opts);
    for (const s of SERVICES) {
      const main = (opts.live ? LIVE_LAUNCHERS : LAUNCHERS)[s] ?? `services/${s}/src/main.ts`;
      const fd = openSync(join(LOGS, `${s}.log`), 'w');
      // Only the stack's env: nothing else from the shell running the test leaks into the services.
      const p = spawn(process.execPath, ['--import', 'tsx', main], { cwd: ROOT, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env }, stdio: ['ignore', fd, fd] });
      closeSync(fd);
      procs.push(p);
    }
    const url = (s: Svc) => `http://127.0.0.1:${PORT[s]}`;
    const log = (s: Svc) => readFileSync(join(LOGS, `${s}.log`), 'utf8').split('\n').slice(-15).join('\n');
    for (const s of SERVICES) {
      let ok = false;
      for (let i = 0; i < 120 && !ok; i++) {
        const p = procs[SERVICES.indexOf(s)]!;
        if (p.exitCode !== null) throw new Error(`${s} exited ${p.exitCode}:\n${log(s)}`);
        ok = await health(url(s));
        if (!ok) await new Promise((r) => setTimeout(r, 250));
      }
      if (!ok) throw new Error(`${s} did not answer /health:\n${log(s)}`);
    }
    return { env, manager, topo, url, log, logs: LOGS, scratch, down };
  } catch (e) {
    await down();
    throw e;
  }
}
