/**
 * DEV ONLY: the sandbox machine's network, rebuilt on one dev PC with Docker, for the e2e and the containment tests.
 *
 *   <name>-sbx   an --internal network: the browse sandboxes and the proxy. No route anywhere else.
 *   <name>-out   an --internal network: the proxy and the fixture site. Also no route out, so a test can never
 *                reach the real internet; real names fail to resolve (dns_failed).
 *   <name>-proxy the real egress-proxy binary (target/debug), in a Debian container on both networks, with its
 *                control socket in a folder shared with the manager. Its dev map sends *.fixture.test to the
 *                fixture site; its dev resolve makes rebind.fixture.test answer 169.254.169.254.
 *   <name>-fixtures  Caddy serving fixtures/site over HTTPS with a throwaway certificate.
 *
 * On the sandbox machine the proxy runs on the host instead, behind nftables (deploy/nftables), and none of the
 * dev settings exist. Every name here starts with the topology's name, and down() removes all of it.
 *
 * SANDBOX_TOPOLOGY=host is that machine's test topology (`make containment`, as root on the sandbox machine, with
 * deploy/sandbox-host set up): the network is a bridge like the production one (vhasbx-t, icc off) under the same
 * nftables table, the proxy is the installed binary running on the host as the proxy's own user (a transient systemd
 * unit), and the fixture site listens on 127.0.0.1 only, let through for the proxy's user by one element of the
 * table's dev_fixtures set that down() removes again.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const MANAGER_BIN = process.env.SANDBOX_MANAGER_BIN ?? join(ROOT, 'target', 'debug', 'sandbox-manager');
export const PROXY_BIN = process.env.SANDBOX_PROXY_BIN ?? join(ROOT, 'target', 'debug', 'egress-proxy');
export const HOST = process.env.SANDBOX_TOPOLOGY === 'host';
// Host mode: must match deploy/sandbox-host (the bridge prefix and the table are in deploy/nftables/sandbox.nft).
const HOST_PROXY_USER = process.env.SANDBOX_HOST_PROXY_USER ?? 'vha-egress';
const HOST_SUBNET = process.env.SANDBOX_HOST_TEST_SUBNET ?? '172.30.79';
const HOST_BRIDGE = 'vhasbx-t';
const HOST_FIXTURES_PORT = 18443;
const NFT_TABLE = ['inet', 'vha_sandbox'];
export const BROWSE_IMAGE = process.env.SANDBOX_BROWSE_IMAGE ?? 'vha-browse:dev';
export const PROBE_IMAGE = process.env.SANDBOX_PROBE_IMAGE ?? 'vha-probe:dev';
// The browse image's base (glibc 2.36): runs the host-built proxy binary. Pinned like the Dockerfile.
const PROXY_BASE = 'node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d';
const CADDY = 'caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d';
const PROXY_PORT = 8201;

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryDocker = (...args: string[]) => {
  try {
    return docker(...args);
  } catch {
    return '';
  }
};

export function dockerReady(): string | null {
  try {
    docker('version', '--format', '{{.Server.Version}}');
  } catch {
    return 'docker is not reachable';
  }
  for (const img of [BROWSE_IMAGE, PROBE_IMAGE]) if (!tryDocker('image', 'inspect', '--format', '{{.Id}}', img)) return `image ${img} is missing: run make images`;
  for (const bin of [MANAGER_BIN, PROXY_BIN]) if (!existsSync(bin)) return `${bin} is missing: run make rust`;
  return null;
}

export interface Topology {
  name: string;
  dir: string;
  proxyIp: string;
  /** The env the docker backend needs, for `sandbox-manager serve` or `probe`. */
  env: Record<string, string>;
  down(): void;
}

function makeCert(dir: string): string {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', '/CN=fixture.test', '-addext', 'subjectAltName=DNS:*.fixture.test,DNS:fixture.test',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
  ], { stdio: 'ignore' });
  chmodSync(join(dir, 'key.pem'), 0o644); // a throwaway key, read by the fixtures container
  const pub = execFileSync('openssl', ['x509', '-in', join(dir, 'cert.pem'), '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
  return createHash('sha256').update(der).digest('base64');
}

export function topologyUp(name = `vha-t${process.pid}`): Topology {
  if (HOST) return hostTopologyUp(name);
  const why = dockerReady();
  if (why) throw new Error(why);
  // A Unix socket path must stay under 108 bytes.
  const base = tmpdir().length < 60 ? tmpdir() : '/tmp';
  const dir = mkdtempSync(join(base, `${name}-`));
  const uid = `${process.getuid!()}:${process.getgid!()}`;
  const t: Topology = { name, dir, proxyIp: '', env: {}, down: () => topologyDown(name, dir) };
  try {
    execFileSync('mkdir', ['-p', join(dir, 'certs'), join(dir, 'run'), join(dir, 'state')]);
    const spki = makeCert(join(dir, 'certs'));
    writeFileSync(join(dir, 'Caddyfile'), readFileSync(join(import.meta.dirname, 'fixtures-tls.Caddyfile')));
    const labels = ['--label', `vha.topology=${name}`];
    docker('network', 'create', '--internal', ...labels, `${name}-sbx`);
    docker('network', 'create', '--internal', ...labels, `${name}-out`);
    const hardened = ['--user', uid, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...labels];
    // Caddy's binary carries a file capability, which no-new-privileges refuses to exec: the (trusted, dev-only)
    // fixture server keeps that one capability instead.
    docker('run', '-d', '--name', `${name}-fixtures`, '--network', `${name}-out`, '--user', uid, '--read-only', ...labels,
      '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE',
      '--tmpfs', '/data', '--tmpfs', '/config', '-e', 'HOME=/data',
      '-v', `${join(ROOT, 'fixtures', 'site')}:/srv:ro`, '-v', `${join(dir, 'certs')}:/certs:ro`,
      '-v', `${join(dir, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, CADDY, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile');
    docker('create', '--name', `${name}-proxy`, '--network', `${name}-sbx`, ...hardened,
      '-v', `${PROXY_BIN}:/usr/local/bin/egress-proxy:ro`, '-v', `${join(dir, 'run')}:/run/egress`,
      '--entrypoint', '/usr/local/bin/egress-proxy', PROXY_BASE,
      'serve', '--listen', `0.0.0.0:${PROXY_PORT}`, '--control', '/run/egress/control.sock',
      '--dev-map', `fixture.test=${name}-fixtures:8443`, '--dev-resolve', 'rebind.fixture.test=169.254.169.254');
    docker('network', 'connect', `${name}-out`, `${name}-proxy`);
    docker('start', `${name}-proxy`);
    t.proxyIp = docker('inspect', '--format', `{{(index .NetworkSettings.Networks "${name}-sbx").IPAddress}}`, `${name}-proxy`);
    const control = join(dir, 'run', 'control.sock');
    for (let i = 0; i < 100 && !existsSync(control); i++) execFileSync('sleep', ['0.1']);
    if (!existsSync(control)) throw new Error(`the proxy did not start: ${tryDocker('logs', `${name}-proxy`)}`);
    t.env = {
      SANDBOX_BACKEND: 'docker',
      SANDBOX_MANAGER_DEV: '1',
      SANDBOX_INSTANCE: name,
      SANDBOX_NETWORK: `${name}-sbx`,
      SANDBOX_PROXY_URL: `http://${t.proxyIp}:${PROXY_PORT}`,
      SANDBOX_PROXY_CONTROL: control,
      SANDBOX_STATE_DIR: join(dir, 'state'),
      SANDBOX_DEV_SPKI: spki,
      SANDBOX_BROWSE_IMAGE: BROWSE_IMAGE,
      SANDBOX_PROBE_IMAGE: PROBE_IMAGE,
      SANDBOX_COMPUTE_IMAGE: process.env.SANDBOX_COMPUTE_IMAGE ?? 'vha-engine-compute:dev',
    };
    return t;
  } catch (e) {
    topologyDown(name, dir);
    throw e;
  }
}

const run = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryRun = (cmd: string, ...args: string[]) => {
  try {
    return run(cmd, ...args);
  } catch {
    return '';
  }
};
const fixturesElement = `{ 127.0.0.1 . ${HOST_FIXTURES_PORT} }`;

/** The sandbox machine's test topology (SANDBOX_TOPOLOGY=host): see the comment at the top. */
function hostTopologyUp(name: string): Topology {
  const why = dockerReady();
  if (why) throw new Error(why);
  if (process.getuid!() !== 0) throw new Error('SANDBOX_TOPOLOGY=host runs as root on the sandbox machine');
  if (!tryRun('nft', 'list', 'table', ...NFT_TABLE)) throw new Error('the nftables table inet vha_sandbox is not loaded: run deploy/sandbox-host/setup.sh');
  const proxyUser = run('id', '-u', HOST_PROXY_USER);
  const dir = mkdtempSync(join('/tmp', `${name}-`));
  const unit = `${name}-proxy`;
  const t: Topology = { name, dir, proxyIp: `${HOST_SUBNET}.1`, env: {}, down: () => hostTopologyDown(name, dir) };
  try {
    chmodSync(dir, 0o711);
    execFileSync('mkdir', ['-p', join(dir, 'certs'), join(dir, 'run'), join(dir, 'state')]);
    execFileSync('chown', [`${proxyUser}:0`, join(dir, 'run')]);
    const spki = makeCert(join(dir, 'certs'));
    const caddyfile = readFileSync(join(import.meta.dirname, 'fixtures-tls.Caddyfile'), 'utf8')
      .replace('https://:8443 {', `https://:${HOST_FIXTURES_PORT} {\n\tbind 127.0.0.1`);
    writeFileSync(join(dir, 'Caddyfile'), caddyfile);
    const labels = ['--label', `vha.topology=${name}`];
    docker('network', 'create', '--subnet', `${HOST_SUBNET}.0/24`, '--gateway', t.proxyIp, ...labels,
      '-o', `com.docker.network.bridge.name=${HOST_BRIDGE}`, '-o', 'com.docker.network.bridge.enable_icc=false', `${name}-sbx`);
    docker('run', '-d', '--name', `${name}-fixtures`, '--network', 'host', '--user', '65534:65534', '--read-only', ...labels,
      '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE',
      '--tmpfs', '/data', '--tmpfs', '/config', '-e', 'HOME=/data',
      '-v', `${join(ROOT, 'fixtures', 'site')}:/srv:ro`, '-v', `${join(dir, 'certs')}:/certs:ro`,
      '-v', `${join(dir, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, CADDY, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile');
    run('nft', 'add', 'element', ...NFT_TABLE, 'dev_fixtures', fixturesElement);
    const control = join(dir, 'run', 'control.sock');
    run('systemd-run', '--quiet', '--collect', `--unit=${unit}`, `--uid=${HOST_PROXY_USER}`, `--gid=${HOST_PROXY_USER}`,
      '-p', 'NoNewPrivileges=yes', '-p', 'PrivateTmp=no', '--', PROXY_BIN,
      'serve', '--listen', `${t.proxyIp}:${PROXY_PORT}`, '--control', control,
      '--dev-map', `fixture.test=127.0.0.1:${HOST_FIXTURES_PORT}`, '--dev-resolve', 'rebind.fixture.test=169.254.169.254');
    for (let i = 0; i < 100 && !existsSync(control); i++) execFileSync('sleep', ['0.1']);
    if (!existsSync(control)) throw new Error(`the proxy did not start: ${tryRun('journalctl', '-u', unit, '-o', 'cat', '--no-pager')}`);
    t.env = {
      SANDBOX_BACKEND: process.env.SANDBOX_BACKEND ?? 'gvisor',
      // On means on: the driver never falls back to --no-sandbox (only `auto` does).
      SANDBOX_CHROMIUM_SANDBOX: process.env.SANDBOX_CHROMIUM_SANDBOX ?? 'on',
      SANDBOX_MANAGER_DEV: '1',
      SANDBOX_INSTANCE: name,
      SANDBOX_NETWORK: `${name}-sbx`,
      SANDBOX_PROXY_URL: `http://${t.proxyIp}:${PROXY_PORT}`,
      SANDBOX_PROXY_CONTROL: control,
      SANDBOX_STATE_DIR: join(dir, 'state'),
      SANDBOX_DEV_SPKI: spki,
      SANDBOX_BROWSE_IMAGE: BROWSE_IMAGE,
      SANDBOX_PROBE_IMAGE: PROBE_IMAGE,
      SANDBOX_COMPUTE_IMAGE: process.env.SANDBOX_COMPUTE_IMAGE ?? 'vha-engine-compute:dev',
    };
    return t;
  } catch (e) {
    hostTopologyDown(name, dir);
    throw e;
  }
}

function hostTopologyDown(name: string, dir: string) {
  tryRun('systemctl', 'stop', `${name}-proxy`);
  tryRun('nft', 'delete', 'element', ...NFT_TABLE, 'dev_fixtures', fixturesElement);
  topologyDown(name, dir);
}

/** Removes every container and network of this topology (sandboxes included), and its folder. */
export function topologyDown(name: string, dir?: string) {
  const ids = [
    ...tryDocker('ps', '-aq', '--filter', `label=vha.topology=${name}`).split('\n'),
    ...tryDocker('ps', '-aq', '--filter', `name=^${name}-`).split('\n'),
  ].filter(Boolean);
  if (ids.length) tryDocker('rm', '-f', ...new Set(ids));
  tryDocker('network', 'rm', `${name}-sbx`, `${name}-out`);
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** This topology's containers that are sandboxes (labelled by the manager). */
export function liveSandboxes(t: Topology): string[] {
  return tryDocker('ps', '-aq', '--filter', `label=vha.instance=${t.name}`).split('\n').filter(Boolean);
}

/** The proxy's own log lines (JSON). */
export function proxyLog(t: Topology): Record<string, unknown>[] {
  return (HOST ? tryRun('journalctl', '-u', `${t.name}-proxy`, '-o', 'cat', '--no-pager') : tryDocker('logs', `${t.name}-proxy`))
    .split('\n')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

export interface Manager {
  url: string;
  proc: ChildProcess;
  stop(): void;
}

/** Starts `sandbox-manager serve` on this topology and waits for /health. */
export async function startManager(t: Topology, callers: string, extra: Record<string, string> = {}): Promise<Manager> {
  const port = 18700 + (process.pid % 1000);
  const url = `http://127.0.0.1:${port}`;
  let stderr = '';
  const proc = spawn(MANAGER_BIN, ['serve'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...t.env, SANDBOX_MANAGER_ADDR: `127.0.0.1:${port}`, SANDBOX_MANAGER_CALLERS: callers, ...extra },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr!.on('data', (d) => (stderr = (stderr + String(d)).slice(-2000)));
  for (let i = 0; i < 150; i++) {
    if (proc.exitCode !== null) throw new Error(`sandbox-manager exited: ${stderr}`);
    if (await fetch(`${url}/health`).then((r) => r.ok).catch(() => false)) return { url, proc, stop: () => proc.kill('SIGTERM') };
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error(`sandbox-manager did not start: ${stderr}`);
}

export interface ProbeReport {
  sandbox_id: string;
  runtime: string;
  exit_code: number | null;
  oom_killed: boolean;
  timed_out: boolean;
  ms: number;
  lines: Record<string, unknown>[];
  proxy_log: { host: string; port: number; allowed: boolean; reason: string }[];
  gone_after: boolean;
}

/** Runs one attack probe in a fresh sandbox, made exactly like a browse job's. */
export function probe(t: Topology, args: string[], opts: { wall?: number; allow?: string[]; env?: Record<string, string> } = {}): Promise<ProbeReport> {
  const flags = [...(opts.wall ? ['--wall', String(opts.wall)] : []), ...(opts.allow ? ['--allow', opts.allow.join(',')] : [])];
  return new Promise((resolve, reject) => {
    const p = spawn(MANAGER_BIN, ['probe', ...flags, '--', ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...t.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err = (err + String(d)).slice(-2000)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`probe ${args[0]} failed (${code}): ${err}`));
      try {
        resolve(JSON.parse(out) as ProbeReport);
      } catch {
        reject(new Error(`probe ${args[0]}: no report: ${out.slice(0, 300)} ${err}`));
      }
    });
  });
}
