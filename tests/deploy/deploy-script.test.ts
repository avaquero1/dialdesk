/**
 * deploy/scripts/deploy.sh --dry-run with the example settings (deploy/deploy.env.example): every control step is
 * printed in order with its commands and the files it would write, and nothing runs. Every command that changes a
 * machine (docker, nft, systemctl, ssh, install, cp, mv, rm…) is a recording fake on PATH, and the record must stay
 * empty. The control-vars.nft it prints defines every variable control.nft uses, and passes `nft -c` with control.nft
 * in a private namespace (skipped where unshare or nft can't run). Bad settings stop it before step 2.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const script = join(root, 'deploy/scripts/deploy.sh');
const example = readFileSync(join(root, 'deploy/deploy.env.example'), 'utf8');
const base = mkdtempSync(join(tmpdir(), 'vha-deploy-script-test-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// Recording fakes: any call is a change the dry run must not make.
const fakeBin = join(base, 'bin');
const record = join(base, 'calls.log');
mkdirSync(fakeBin);
for (const cmd of ['docker', 'nft', 'systemctl', 'systemd-run', 'ufw', 'ssh', 'curl', 'getent', 'install', 'cp', 'mv', 'rm', 'chmod', 'mkdir', 'tar']) {
  writeFileSync(join(fakeBin, cmd), `#!/usr/bin/env bash\necho "${cmd} $*" >> "${record}"\n`);
  chmodSync(join(fakeBin, cmd), 0o755);
}

function deploy(args: string[], env: string = example, extraEnv: Record<string, string> = {}) {
  const file = join(base, `deploy-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(file, env);
  rmSync(record, { force: true });
  const r = spawnSync('bash', [script, ...args.map((a) => (a === '@env' ? file : a))], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...extraEnv },
  });
  let calls = '';
  try {
    calls = readFileSync(record, 'utf8');
  } catch {
    /* no calls: as it should be */
  }
  return { code: r.status, out: r.stdout, err: r.stderr, calls };
}
const withSetting = (key: string, value: string) =>
  example.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);

const STEPS = ['checks', 'images', 'firewall', 'egress table', 'buckets', 'secrets', 'database', 'services', 'health', 'sandbox machine'];

describe('deploy.sh control --dry-run', () => {
  const r = deploy(['control', '--dry-run', '--env-file', '@env']);

  it('runs every step in order and changes nothing', () => {
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const heads = [...r.out.matchAll(/^== (\d+)\/(\d+) (.+)$/gm)];
    expect(heads.map((m) => Number(m[1]))).toEqual(STEPS.map((_, i) => i + 1));
    heads.forEach((m, i) => expect(m[3]!.startsWith(STEPS[i]!), m[3]).toBe(true));
    expect(r.out).toContain('deploy: dry run done (10 steps), nothing changed');
    expect(r.calls).toBe('');
  });

  it('prints the commands of each step', () => {
    const want = [
      /docker build .*--target app .*-t vha\/app:[0-9a-f]{12}/,
      /docker build .*--target caddy .*-t vha\/caddy:[0-9a-f]{12}/,
      /nft -c -I \/etc\/vha\/nft\.new -f \/etc\/vha\/nft\.new\/control\.nft/,
      /install -m 0644 \S+\/egress-log-only\.nft \/etc\/vha\/nft\.new\/control-egress-mode\.nft/,
      /write \/etc\/systemd\/system\/vha-nft\.service/,
      /ExecStart=\/usr\/sbin\/nft -I \/etc\/vha\/nft -f \/etc\/vha\/nft\/control\.nft/,
      /systemd-run .*--unit vha-nft-rollback --on-active=300s .*\/usr\/local\/sbin\/vha-nft-rollback/,
      /^vha-nft: waiting for confirm/m,
      /ufw disable/,
      /docker run .*--network none .*node --import tsx deploy\/egress-hosts\.ts > \/etc\/vha\/nft\/egress-hosts\.txt/,
      /install -m 0755 \S+\/egress-refresh\.sh \/etc\/vha\/nft\/egress-refresh\.sh/,
      /\/etc\/vha\/nft\/egress-refresh\.sh --check/,
      /systemctl enable --now vha-egress-refresh\.timer/,
      /node --import tsx deploy\/s3-bucket\.ts/,
      /docker run .*--user 0:0 --network none .*-v \/etc\/vha\/secrets:\/out .*deploy\/prod-secrets\.ts --out \/out$/m,
      /-e PGSSLMODE=require .*-v \/etc\/vha\/inputs\/pg-admin\.pgpass:\/run\/pg\/pgpass:ro -v \/etc\/vha\/secrets\/postgres\/env:\/run\/pg\/env:ro/,
      /psql\\ -X\\ -q\\ -v\\ ON_ERROR_STOP=1\\ -f\\ \/run\/pg\/db-init\.sql/,
      /docker compose -p vha-control -f \S+\/deploy\/compose\.control\.yml --env-file \S+ --env-file \/etc\/vha\/release\.env up -d --wait/,
      /curl .*--resolve vultrcontest\.vaquerothe\.dev:443:127\.0\.0\.1 .*https:\/\/vultrcontest\.vaquerothe\.dev\//,
      /exec -T runner wget .*http:\/\/10\.1\.96\.4:8200\/health/,
      /SANDBOX_MANAGER_TOKEN_FILE|sandbox machine's own/,
    ];
    for (const re of want) expect(r.out, String(re)).toMatch(re);
    expect(r.out).toContain('egress mode: log-only');
  });

  it('writes a control-vars.nft that defines every variable control.nft uses, and passes nft -c', () => {
    const vars = [...r.out.matchAll(/^ {3}\| (define .*)$/gm)].map((m) => m[1]!).join('\n') + '\n';
    const nft = readFileSync(join(root, 'deploy/nftables/control.nft'), 'utf8');
    const used = new Set([...nft.matchAll(/\$([A-Z_]+)/g)].map((m) => m[1]!));
    const defined = new Set([...vars.matchAll(/^define ([A-Z_]+) =/gm)].map((m) => m[1]!));
    expect([...used].filter((v) => !defined.has(v))).toEqual([]);
    expect(vars).toContain('define ADMIN_IP = 203.0.113.10');
    expect(vars).toContain('define PG_IP = 10.1.96.5');

    const dir = join(base, 'nft');
    mkdirSync(dir);
    writeFileSync(join(dir, 'control-vars.nft'), vars);
    copyFileSync(join(root, 'deploy/nftables/control.nft'), join(dir, 'control.nft'));
    copyFileSync(join(root, 'deploy/nftables/egress-log-only.nft'), join(dir, 'control-egress-mode.nft'));
    const c = spawnSync('unshare', ['-rn', 'nft', '-c', '-I', dir, '-f', join(dir, 'control.nft')], { encoding: 'utf8' });
    if (c.error || /unshare: |command not found|Operation not permitted/.test(c.stderr)) return; // no netns here
    expect(c.stderr).toBe('');
    expect(c.status).toBe(0);
  });

  it('prints no input file contents and no secret', () => {
    expect(r.out).not.toMatch(/access_key_id|secret_access_key|PGPASSWORD|BEGIN [A-Z ]*PRIVATE KEY/);
  });
});

describe('deploy.sh control --dry-run, options and settings', () => {
  it('--enforce-egress installs the enforce mode', () => {
    const r = deploy(['--dry-run', '--env-file', '@env', '--enforce-egress']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/install -m 0644 \S+\/egress-enforce\.nft \/etc\/vha\/nft\.new\/control-egress-mode\.nft/);
    expect(r.out).toContain('egress mode: enforce');
    expect(r.calls).toBe('');
  });

  it('--rotate reaches prod-secrets, --rollback-seconds the timer', () => {
    const r = deploy(['--dry-run', '--env-file', '@env', '--rotate', '--rollback-seconds', '120']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/deploy\/prod-secrets\.ts --out \/out --rotate$/m);
    expect(r.out).toContain('--on-active=120s');
  });

  it('VHA_LOCAL_DB=1: no Managed Postgres settings needed, the local-db profile, no db-init run', () => {
    const env = withSetting('VHA_LOCAL_DB', '1').replace(/^PG_.*$/gm, '');
    const r = deploy(['--dry-run', '--env-file', '@env'], env);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/prod-secrets\.ts --out \/out --local-db$/m);
    expect(r.out).toContain('--profile local-db up -d --wait');
    expect(r.out).not.toContain('db-init.sql:ro');
  });

  it('no S3_ENDPOINT: the buckets step is skipped', () => {
    const r = deploy(['--dry-run', '--env-file', '@env'], withSetting('S3_ENDPOINT', ''));
    expect(r.code).toBe(0);
    expect(r.out).toContain('no S3_ENDPOINT: skipped');
    expect(r.out).not.toContain('deploy/s3-bucket.ts');
  });

  it('PG_IP empty: resolved at deploy time (shown, not resolved, in a dry run)', () => {
    const r = deploy(['--dry-run', '--env-file', '@env'], withSetting('PG_IP', ''));
    expect(r.code).toBe(0);
    expect(r.out).toContain('would resolve vultr-prod-pg.example.invalid');
    expect(r.calls).toBe('');
  });

  const refused: [string, string, RegExp][] = [
    ['a missing setting', example.replace(/^SANDBOX_VPC_IP=.*$/m, ''), /not set: SANDBOX_VPC_IP/],
    ['an address with nft in it', withSetting('ADMIN_IP', '0.0.0.0/0 accept'), /ADMIN_IP must be an IPv4 address/],
    ['a public database address', withSetting('PG_IP', '198.51.100.7'), /isn't a VPC \(private\) address/],
    ['a database without TLS', withSetting('PG_SSLMODE', 'disable'), /PG_SSLMODE must be/],
    ['an input file outside /etc/vha/inputs', withSetting('BRAVE_KEY_FILE', '/root/.ssh/id_ed25519'), /BRAVE_KEY_FILE must be a file under/],
    ['another host name than the Caddyfile', withSetting('VHA_HOSTNAME', 'example.com'), /isn't the site in deploy\/Caddyfile/],
    ['a line that is not KEY=value', example + 'export FOO=bar\n', /not a KEY=value line/],
  ];
  for (const [what, env, msg] of refused) {
    it(`refuses ${what} before it changes anything`, () => {
      const r = deploy(['--dry-run', '--env-file', '@env'], env);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(msg);
      expect(r.out).not.toContain('== 2/10');
      expect(r.calls).toBe('');
    });
  }

  it('refuses an unknown option', () => {
    const r = deploy(['--dry-run', '--env-file', '@env', '--yolo']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown option --yolo');
  });
});

describe('deploy.sh push and sandbox --dry-run (the dev PC side)', () => {
  const machines = { VHA_CONTROL_HOST: 'root@control.example.invalid', VHA_SANDBOX_HOST: 'root@sandbox.example.invalid', VHA_SSH_KEY: '/nonexistent/key' };

  it('push copies HEAD, does the sandbox machine first, runs control there and confirms over a new connection', () => {
    const r = deploy(['push', '--dry-run', '--env-file', '@env', '--enforce-egress'], example, machines);
    expect(r.err.replace(/^push: uncommitted changes are NOT copied.*\n/m, '')).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/git archive --format=tar HEAD \| ssh root@control\.example\.invalid .*\/opt\/vha\/src\/[0-9a-f]{12}/);
    const sbx = r.out.indexOf('== 2/3 the sandbox machine first');
    const ctl = r.out.indexOf('== 3/3 run deploy.sh control');
    expect(sbx).toBeGreaterThan(0);
    expect(ctl).toBeGreaterThan(sbx);
    // control reads its own /etc/vha/deploy.env: the local --env-file is not passed on.
    expect(r.out).toMatch(/deploy\/scripts\/deploy\.sh\\? control\\? --dry-run\\? --enforce-egress'?$/m);
    expect(r.out).toContain('ssh root@control.example.invalid vha-nft-confirm');
    expect(r.calls).toBe('');
  });

  it('push without VHA_SANDBOX_HOST does control only', () => {
    const r = deploy(['push', '--dry-run'], example, { ...machines, VHA_SANDBOX_HOST: '' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('== 2/2 run deploy.sh control');
    expect(r.out).not.toContain('sandbox-host/push.sh');
  });

  it('sandbox: checks the VPC, runs setup.sh with the VPC flags, moves the manager to the VPC address, copies the token', () => {
    const r = deploy(['sandbox', '--dry-run', '--env-file', '@env'], example, machines);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const want = [
      /ssh root@sandbox\.example\.invalid .*ip\\? -4\\? -o\\? addr\\? show\\? dev\\? enp8s0.*10\.1\.96\.4/,
      /deploy\/sandbox-host\/push\.sh --ssh-from 203\.0\.113\.10 --vpc-if enp8s0 --control-vpc-ip 10\.1\.96\.3 --vpc-subnet 10\.1\.96\.0\/20$/m,
      /ssh root@sandbox\.example\.invalid vha-nft-confirm/,
      /SANDBOX_MANAGER_ADDR=10\.1\.96\.4:8200/,
      /systemctl\\? restart\\? vha-sandbox-manager/,
      /ssh root@sandbox\.example\.invalid cat \/etc\/vha\/runner-token \| ssh root@control\.example\.invalid .*\/etc\/vha\/inputs\/sandbox-runner-token/,
    ];
    for (const re of want) expect(r.out, String(re)).toMatch(re);
    // In order: VPC, setup, confirm, manager address, token.
    const at = want.map((re) => r.out.search(re));
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(r.calls).toBe('');
  });

  it('a dry run of the sandbox part needs a local --env-file; push needs the machines', () => {
    expect(deploy(['sandbox', '--dry-run'], example, machines).err).toMatch(/needs --env-file/);
    const r = deploy(['push', '--dry-run'], example, { VHA_CONTROL_HOST: '', VHA_SSH_KEY: '' });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/VHA_SSH_KEY/);
  });
});

describe('control.nft', () => {
  it('keeps a drop policy on input and forward (ufw is turned off on both machines)', () => {
    const nft = readFileSync(join(root, 'deploy/nftables/control.nft'), 'utf8');
    expect(nft).toMatch(/chain input \{\s*type filter hook input priority filter - 10; policy drop;/);
    expect(nft).toMatch(/chain forward \{\s*type filter hook forward priority filter - 10; policy drop;/);
    expect(nft).toMatch(/iifname \$PUBLIC_IF ip saddr \$ADMIN_IP tcp dport 22 accept/);
  });
});
