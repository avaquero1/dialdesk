/**
 * runner's own run code (runJob: plans, reads, the reader and guard, the engine, publish) for one widget of the local web
 * stack, whose runner is a fake. It talks to the stack's board, markets, models (the fake: canned reader, summarizer and
 * guard answers), connections and Valkey as the runner, with the runner's tokens from .env, so the result, the
 * screenshots, the live run steps and the sealed boxes' audit rows land where the real runner puts them.
 *
 * The sandboxes are sandbox-manager on its stub backend (no Docker; compute runs the real engine in process), and each
 * browse box's page is the fixture site's article: its text the way a careless extractor sees it (hidden text and comments
 * kept, so the poisoned page's orders are there to catch) and a screenshot of it rendered in Chromium, as the real box
 * takes one. Needs `cargo build -p sandbox-manager` (make check builds it) and `web/dev/stack.sh up`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { widgetRunJobId, type RunKind, type WidgetRunJob } from '@app/contracts';
import { busFromConfig, clientFromEnv, hashToken, sandboxClient, type SandboxClient } from '@app/service-kit';
import { fixtures, pageText, TEST_TOKENS } from '@app/testkit';
import { MemoryStore, runJob, type RunRecord, type RunnerDeps } from '../../services/runner/src/index.ts';
import { stackEnv, stackService } from './stack.ts';

const ROOT = join(import.meta.dirname, '../..');
const MANAGER = join(ROOT, 'target', 'debug', 'sandbox-manager');

type Job = Awaited<ReturnType<SandboxClient['getJob']>>;

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? res(a.port) : rej(new Error('no port'))));
    });
  });
}

export interface StackRunner {
  /** One run of a widget, as runner's worker runs a job (reason "refresh": the user tapped Refresh now). */
  run: (widget_id: string, account_id: string, kind: RunKind) => Promise<RunRecord>;
  close: () => Promise<void>;
}

/** `shot(url, html)`: a PNG (base64) of the fixture page, as a browse box screenshots it. */
export async function stackRunner(shot: (url: string, html: string) => Promise<string>): Promise<StackRunner> {
  if (!existsSync(MANAGER)) throw new Error('build sandbox-manager first: cargo build -p sandbox-manager (make check does)');
  const port = await freePort();
  const token = TEST_TOKENS.runner;
  const manager: ChildProcess = spawn(MANAGER, ['serve'], {
    env: { ...process.env, SANDBOX_BACKEND: 'stub', SANDBOX_MANAGER_ADDR: `127.0.0.1:${port}`, SANDBOX_MANAGER_CALLERS: `runner:${hashToken(token)}`, SANDBOX_MANAGER_DEV: '1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) {
    manager.kill();
    throw new Error('sandbox-manager (stub) did not start');
  }

  // The stub opens no browser: a held browse box gets its fixture page here, text and screenshot.
  const sbx = sandboxClient({ baseUrl: base, token });
  const urls = new Map<string, string>();
  const pngs = new Map<string, string>();
  const withPage = async (j: Job): Promise<Job> => {
    const url = urls.get(j.job_id);
    if (!url || j.pages.length || j.state !== 'held') return j;
    const f = fixtures.manifest().find((x) => x.url === url);
    if (!f) return j;
    const html = fixtures.page(f.file);
    if (!pngs.has(url)) pngs.set(url, await shot(url, html));
    return { ...j, pages: [{ url, status: 200, text: pageText(html), screenshot_png_b64: pngs.get(url)! }] };
  };
  const sandbox: SandboxClient = {
    ...sbx,
    createJob: async (job) => {
      if (job.kind === 'browse' && job.browse?.urls[0]) urls.set(job.job_id, job.browse.urls[0]);
      return withPage(await sbx.createJob(job));
    },
    getJob: async (id) => withPage(await sbx.getJob(id)),
  };

  const env = stackEnv();
  for (const s of ['markets', 'models', 'connections']) env[`RUNNER_URL_${s.toUpperCase()}`] = stackService(s);
  const bus = busFromConfig('runner', { VALKEY_URL: env.RUNNER_VALKEY_URL });
  const store = new MemoryStore();
  const deps: RunnerDeps = {
    board: await clientFromEnv('runner', 'board', env),
    markets: await clientFromEnv('runner', 'markets', env),
    models: await clientFromEnv('runner', 'models', env),
    connections: await clientFromEnv('runner', 'connections', env),
    sandbox,
    bus,
    // As the real runner: the stream answers no row id; audit assigns it when it reads the entry.
    audit: async (e) => {
      await bus.log(e);
      return null;
    },
    store,
    sourceEnv: 'fixture',
    pollMs: 100,
  };
  return {
    run: async (widget_id, account_id, kind) => {
      const window_start = Math.floor(Date.now() / 60_000) * 60;
      const job: WidgetRunJob = { job_id: widgetRunJobId(widget_id, kind, window_start), widget_id, account_id, kind, window_start, reason: 'refresh' };
      await runJob(deps, job, { jobId: job.job_id, attempt: 1, signal: new AbortController().signal });
      const rec = [...store.runs.values()].filter((r) => r.widget_id === widget_id).at(-1);
      if (!rec) throw new Error('the run left no record');
      return rec;
    },
    close: async () => {
      await bus.close().catch(() => {});
      manager.kill();
    },
  };
}
