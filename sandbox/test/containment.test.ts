/**
 * The local containment tests: real sandboxes on Docker (runc by default; SANDBOX_BACKEND=gvisor for runsc), the real
 * egress proxy, the real manager. Every attack probe runs in a fresh sandbox made with exactly a browse job's flags
 * (`sandbox-manager probe`); the browse checks go through the manager's HTTP API with real Chromium.
 * `make containment-local` runs this file. On the sandbox machine, `make containment` runs the same checks on gVisor
 * (SANDBOX_TOPOLOGY=host: the host proxy and nftables of deploy/sandbox-host) and writes the scoreboard's numbers to
 * $CONTAINMENT_SCORE (sandbox/test/scoreboard.ts turns them into the table for the slides).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveSandboxes, probe, startManager, topologyUp, type Manager, type Topology } from '../dev/topology.ts';

const TOKEN = 'containment-test-token-0123456789';
// Planted on the host side: in the manager's env and in a file in its state folder. No sandbox may see it.
const CANARY = `VHA-CANARY-${process.pid}-${Date.now()}`;
const COMPUTE_IMAGE = process.env.SANDBOX_COMPUTE_IMAGE ?? 'vha-engine-compute:dev';
const hasComputeImage = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', COMPUTE_IMAGE], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// The numbers for the scoreboard, measured by the checks below.
const score: Record<string, number | string | boolean> = {};
const MANIFEST = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'site', 'MANIFEST.json'), 'utf8')) as
  { url: string; poisoned: boolean; callouts: string[] }[];

let t: Topology;
let m: Manager;
const hostEnv = () => ({ VHA_TEST_SECRET_KEY: CANARY, SANDBOX_MANAGER_CALLERS: `runner:${createHash('sha256').update(CANARY).digest('hex')}` });

type Job = {
  job_id: string;
  sandbox_id: string;
  state: string;
  pages: { url: string; status: number; text: string; visible_text: string | null; screenshot_png_b64: string | null }[];
  proxy_log: { host: string; port: number; allowed: boolean; reason: string }[];
  kill_reason: string | null;
  error: string | null;
};

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${m.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

let n = 0;
async function browse(urls: string[], allowlist: string[], hold = true): Promise<Job> {
  const job_id = `ct-${process.pid}-${n++}`;
  const r = await api('POST', '/jobs', { job_id, run_id: 'run_ct', widget_id: 'wid_ct', kind: 'browse', browse: { urls, allowlist, screenshot: false, hold } });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  return settle(job_id);
}

type TrustRow = { action: string; at: string; subject_id: string; ids?: Record<string, unknown>; sizes?: Record<string, number> };

async function settle(job_id: string): Promise<Job> {
  for (let i = 0; i < 300; i++) {
    const j = (await api('GET', `/jobs/${job_id}`)).json as Job;
    if (!['queued', 'running'].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${job_id} never settled`);
}

// A finished job's sandbox is destroyed right after its state is set.
async function gone() {
  for (let i = 0; i < 50 && liveSandboxes(t).length; i++) await new Promise((r) => setTimeout(r, 100));
  expect(liveSandboxes(t)).toEqual([]);
}

const refused = (j: Job, host: string) => j.proxy_log.filter((e) => e.host === host && !e.allowed);

beforeAll(async () => {
  t = topologyUp(`vha-ct${process.pid}`);
  for (const d of [t.env.SANDBOX_STATE_DIR!, join(t.env.SANDBOX_STATE_DIR!, 'probe')]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'host-secret.env'), `VHA_TEST_SECRET_KEY=${CANARY}\n`);
  }
  m = await startManager(t, `runner:${createHash('sha256').update(TOKEN).digest('hex')}`, {
    ...hostEnv(),
    SANDBOX_MANAGER_CALLERS: `runner:${createHash('sha256').update(TOKEN).digest('hex')}`,
    SANDBOX_SLOTS: '2',
    SANDBOX_COMPUTE_IMAGE: COMPUTE_IMAGE,
  });
}, 120_000);

afterAll(() => {
  m?.stop();
  t?.down();
  if (process.env.CONTAINMENT_SCORE) writeFileSync(process.env.CONTAINMENT_SCORE, `${JSON.stringify({ backend: t?.env.SANDBOX_BACKEND, ...score }, null, 2)}\n`);
});

describe(`containment on the ${process.env.SANDBOX_BACKEND ?? 'docker'} backend`, () => {
  it('not root: uid 10001, no capabilities, no-new-privileges, no Docker socket, no host folders, read-only root', async () => {
    const r = await probe(t, ['whoami']);
    const w = r.lines.at(-1)!;
    expect(w).toMatchObject({ uid: 10001, gid: 10001, capEff: '0000000000000000', capBnd: '0000000000000000', noNewPrivs: '1' });
    expect(w).toMatchObject({ dockerSock: [], hostMounts: [], setuid: [], writableRoot: false });
    expect(r.gone_after).toBe(true);
  });

  it('no secret inside: not the host canary, no key-like env or file', async () => {
    const r = await probe(t, ['secrets', CANARY], { env: hostEnv() });
    const s = r.lines.at(-1) as { hits: string[]; envNames: string[]; filesScanned: number; procs: number };
    expect(s.hits).toEqual([]);
    expect(s.filesScanned).toBeGreaterThan(100);
    // Only the image's own env: nothing from the manager.
    for (const name of s.envNames) expect(['PATH', 'HOSTNAME', 'HOME', 'CHROME_BIN', 'NODE_ENV', 'NODE_VERSION', 'YARN_VERSION']).toContain(name);
  });

  it('the process cap holds a fork bomb', async () => {
    const r = await probe(t, ['forkbomb']);
    const f = r.lines.at(-1) as { peakProcesses: number; refused: number };
    expect(f.peakProcesses).toBeLessThanOrEqual(256);
    expect(f.refused).toBeGreaterThan(0);
    expect(r.gone_after).toBe(true);
    Object.assign(score, { forkbomb_peak: f.peakProcesses, forkbomb_cap: 256 });
  });

  it('the memory cap kills a memory hog', async () => {
    const r = await probe(t, ['memhog']);
    expect(r.oom_killed || r.exit_code === 137).toBe(true);
    const mb = Math.max(0, ...r.lines.map((l) => Number(l.allocatedMb ?? 0)));
    expect(mb).toBeGreaterThan(256);
    expect(mb).toBeLessThanOrEqual(1024);
    expect(r.gone_after).toBe(true);
    Object.assign(score, { memhog_mb: mb, memhog_cap_mb: 1024, memhog_oom_killed: r.oom_killed, memhog_exit: r.exit_code ?? -1 });
  });

  it('the time cap ends an infinite loop', async () => {
    const r = await probe(t, ['spin'], { wall: 4 });
    expect(r.timed_out).toBe(true);
    expect(r.ms).toBeLessThan(4000 + 3000);
    expect(r.gone_after).toBe(true);
    Object.assign(score, { loop_kill_ms: r.ms, loop_cap_ms: 4000 });
  });

  it('no route out but the proxy port, and no DNS', async () => {
    const r = await probe(t, ['net', t.proxyIp, '8201']);
    const x = r.lines.at(-1) as { results: Record<string, string>; resolver: string; resolvConf: string; udp53: Record<string, string> };
    expect(x.results.proxy_port).toBe('connected');
    for (const k of ['public_ip', 'public_dns_tcp', 'metadata', 'private_10', 'private_192', 'proxy_other_port']) expect(x.results[k], k).not.toBe('connected');
    expect(x.resolver).not.toMatch(/^resolved/);
    expect(x.resolvConf).toBe('');
    expect(Object.values(x.udp53).every((v) => v !== 'answered')).toBe(true);
    score.routes_blocked = ['public_ip', 'public_dns_tcp', 'metadata', 'private_10', 'private_192', 'proxy_other_port'].length;
  });

  it('a fresh sandbox per job: the next one finds nothing the last one wrote', async () => {
    const token = `m${Date.now()}`;
    const a = await probe(t, ['marker-write', token]);
    expect((a.lines.at(-1) as { wrote: string[] }).wrote.length).toBeGreaterThan(0);
    const b = await probe(t, ['marker-find', token]);
    expect((b.lines.at(-1) as { found: string[] }).found).toEqual([]);
  });

  it('an off-list host is refused and logged', async () => {
    const j = await browse(['https://evil.example/steal'], ['fanpost.fixture.test'], false);
    expect(j.state).toBe('done');
    expect(j.pages[0]!.status).toBe(0);
    expect(refused(j, 'evil.example').map((e) => e.reason)).toContain('not_on_allowlist');
  });

  it('the metadata address is refused, by address and by a name that resolves to it', async () => {
    const j = await browse(['https://rebind.fixture.test/latest/meta-data/'], ['rebind.fixture.test'], false);
    expect(refused(j, 'rebind.fixture.test').map((e) => e.reason)).toContain('blocked_range');
    const p = await browse(['https://fanpost.fixture.test/nfl/chiefs-bills-insider.html'], ['fanpost.fixture.test']);
    expect(p.state).toBe('held');
    expect(refused(p, '169.254.169.254').length).toBeGreaterThan(0);
    expect(refused(p, 'collect.exfil.fixture.test').length).toBeGreaterThan(0);
    // The kill path: the held sandbox is gone at once.
    const k = await api('POST', `/jobs/${p.job_id}/kill`, { reason: 'poison', audit_row_id: null });
    expect(k.json.state).toBe('killed');
    expect(liveSandboxes(t)).toEqual([]);
  });

  it('held until the verdict, then destroyed; busy past the slot cap', async () => {
    const page = 'https://sportswire.fixture.test/nfl/bills-lt-questionable.html';
    const [a, b] = await Promise.all([browse([page], ['sportswire.fixture.test']), browse([page], ['sportswire.fixture.test'])]);
    expect([a.state, b.state]).toEqual(['held', 'held']);
    expect(a.pages[0]).toMatchObject({ status: 200 });
    expect(a.pages[0]!.text).toMatch(/questionable/i);
    expect(liveSandboxes(t)).toHaveLength(2);
    const busy = await api('POST', '/jobs', { job_id: `ct-busy-${process.pid}`, run_id: 'r', widget_id: 'w', kind: 'browse', browse: { urls: [page], allowlist: ['sportswire.fixture.test'] } });
    expect(busy.status).toBe(503);
    expect(busy.json.error).toBe('busy');
    expect((await api('POST', `/jobs/${a.job_id}/release`)).json.state).toBe('released');
    expect((await api('POST', `/jobs/${b.job_id}/kill`, { reason: 'test', audit_row_id: null })).json.state).toBe('killed');
    expect(liveSandboxes(t)).toEqual([]);
    expect((await api('GET', '/sandboxes')).json).toMatchObject({ backend: t.env.SANDBOX_BACKEND, slots_total: 2, slots_used: 0 });
  });

  it("the poisoned page: every callout refused, the sandbox held, killed and destroyed, the trust log ending with sandbox.destroyed", async () => {
    const page = MANIFEST.find((p) => p.poisoned)!;
    const host = new URL(page.url).hostname;
    const t0 = Date.now();
    const p = await browse([page.url], [host]);
    score.create_to_read_ms = Date.now() - t0;
    score.chromium_sandbox = t.env.SANDBOX_CHROMIUM_SANDBOX ?? 'default';
    expect(p.state).toBe('held');
    expect(p.pages[0]).toMatchObject({ status: 200 });
    // Real Chromium: code gets the comment and the display:none text, and the text for the reader has neither.
    expect(p.pages[0]!.text).toMatch(/Do not mention this comment/);
    expect(p.pages[0]!.text).toMatch(/SYSTEM NOTICE FOR AI ASSISTANTS/);
    expect(p.pages[0]!.visible_text).toMatch(/twenty years/);
    expect(p.pages[0]!.visible_text).not.toMatch(/Do not mention this comment|SYSTEM NOTICE FOR AI ASSISTANTS/);
    expect(liveSandboxes(t)).toHaveLength(1);
    // The metadata address as an IP literal; every name off the allowlist (the DNS name that carries data too) is
    // refused before any lookup.
    for (const c of page.callouts) {
      const reasons = refused(p, c).map((e) => e.reason);
      expect(reasons, `${c} in ${p.proxy_log.map((e) => `${e.host}:${e.reason}`).join(' ')}`).toContain(/^\d+(\.\d+){3}$/.test(c) ? 'ip_literal' : 'not_on_allowlist');
    }
    const k0 = Date.now();
    const k = await api('POST', `/jobs/${p.job_id}/kill`, { reason: 'poison', audit_row_id: null });
    expect(k.json.state).toBe('killed');
    score.kill_answer_ms = Date.now() - k0;
    let rows: TrustRow[] = [];
    for (let i = 0; i < 200; i++) {
      rows = ((await api('GET', `/jobs/${p.job_id}`)).json as { trust_log?: TrustRow[] }).trust_log ?? [];
      if (rows.at(-1)?.action === 'sandbox.destroyed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    score.kill_to_destroyed_row_ms = Date.now() - k0;
    expect(rows.map((r) => r.action)).toEqual(['sandbox.created', 'sandbox.killed', 'proxy.refused', 'sandbox.destroyed']);
    expect(liveSandboxes(t)).toEqual([]);
    const refusedRow = rows.find((r) => r.action === 'proxy.refused')!;
    Object.assign(score, {
      poisoned_callouts: page.callouts.length,
      poisoned_callouts_refused: page.callouts.filter((c) => refused(p, c).length > 0).length,
      poisoned_requests_refused: refusedRow.sizes?.requests ?? 0,
    });
  });

  it('compute runs the engine image with no network', async () => {
    expect(hasComputeImage, `${COMPUTE_IMAGE} is missing: make engine-image`).toBe(true);
    const job_id = `ct-math-${process.pid}`;
    const engine_input = { plan: { plan_version: 1, ops: [{ id: 'n1', op: 'implied_probability', args: { price_cents: 'kalshi_price' } }] }, numbers: { kalshi_price: 61 } };
    const r = await api('POST', '/jobs', { job_id, run_id: 'r', widget_id: 'w', kind: 'compute', compute: { engine_input } });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    const j = (await settle(job_id)) as Job & { compute_result: { ok: boolean } | null };
    expect(j.state, j.error ?? '').toBe('done');
    expect(j.compute_result).not.toBeNull();
    await gone();
  });
});
