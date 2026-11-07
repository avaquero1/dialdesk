/**
 * deploy/nftables/egress-refresh.sh on a fake resolver and a fake clock: every allow_* set is flushed and refilled in
 * one script, addresses are kept for 6 h after they were last seen, a host taken off the table loses its addresses,
 * and non-public answers are left out. Then the real thing in a private network namespace (`unshare -rn`, never
 * this machine's own firewall): control.nft loads, the refill passes `nft -c` and loads, and the sets hold the
 * addresses. The namespace part is skipped where unshare or nft can't run.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const nftDir = join(root, 'deploy/nftables');
const script = join(nftDir, 'egress-refresh.sh');
const base = mkdtempSync(join(tmpdir(), 'vha-egress-refresh-test-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// A resolver that answers like `getent ahostsv4` from a map file (`<host> <ip>...`), and fails for unknown hosts.
const dnsFile = join(base, 'dns');
const resolver = join(base, 'fake-getent');
writeFileSync(
  resolver,
  `#!/usr/bin/env bash\nline="$(grep -F "$1 " "${dnsFile}" | head -n1)"; [ -n "$line" ] || exit 2\nfor ip in \${line#* }; do echo "$ip STREAM $1"; done\n`,
);
chmodSync(resolver, 0o755);
// An nft that records the script it was given (for the runs outside a namespace).
const fakeBin = join(base, 'bin');
execFileSync('mkdir', ['-p', fakeBin]);
writeFileSync(join(fakeBin, 'nft'), `#!/usr/bin/env bash\n[ "$1" = -f ] && cp "$2" "${base}/applied.nft"\n`);
chmodSync(join(fakeBin, 'nft'), 0o755);

const hostsFile = join(base, 'egress-hosts.txt');
const state = join(base, 'state/seen');
const T0 = 1_800_000_000;
const HOUR = 3600;

function refresh(args: string[], now: number, opts: { fakeNft?: boolean; extraEnv?: Record<string, string> } = {}) {
  const env = {
    ...process.env,
    PATH: opts.fakeNft === false ? process.env.PATH! : `${fakeBin}:${process.env.PATH}`,
    VHA_EGRESS_HOSTS: hostsFile,
    VHA_EGRESS_STATE: state,
    VHA_RESOLVE: resolver,
    VHA_NOW: String(now),
    ...opts.extraEnv,
  };
  const r = spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const elements = (nft: string, set: string) =>
  [...nft.matchAll(/add element inet vha allow_(\w+) \{ ([^}]*) \}/g)].find((m) => m[1] === set)?.[2]?.split(', ') ?? [];

writeFileSync(
  hostsFile,
  [
    '# test table',
    'models api.vultrinference.com',
    'markets www.espn.com',
    'markets cdn.example.com',
    'audit ewr1.vultrobjects.com',
    'board ewr1.vultrobjects.com',
    '',
  ].join('\n'),
);

// Each case runs the script a few times (many small processes): generous on a loaded build box.
describe('egress-refresh.sh', { timeout: 30_000 }, () => {
  it('flushes every set and refills it in one script (dry run changes nothing)', () => {
    writeFileSync(
      dnsFile,
      'api.vultrinference.com 45.32.1.1\nwww.espn.com 151.101.2.1 151.101.66.1\ncdn.example.com 151.101.2.1\newr1.vultrobjects.com 108.61.0.9\n',
    );
    const r = refresh(['--dry-run'], T0);
    expect(r.code, r.err).toBe(0);
    for (const set of ['caddy', 'models', 'markets', 'connections', 'audit', 'board']) expect(r.out).toContain(`flush set inet vha allow_${set}\n`);
    expect(elements(r.out, 'markets')).toEqual(['151.101.2.1', '151.101.66.1']);
    expect(elements(r.out, 'audit')).toEqual(['108.61.0.9']);
    expect(elements(r.out, 'board')).toEqual(['108.61.0.9']);
    expect(elements(r.out, 'caddy')).toEqual([]);
    expect(r.out).not.toMatch(/add element inet vha allow_caddy/);
    expect(r.out).toContain('allow_markets: 2 hosts, 2 addresses');
    expect(spawnSync('test', ['-e', state]).status).toBe(1);
  });

  it('keeps an address for 6 h after it was last seen, then drops it', () => {
    expect(refresh([], T0).code).toBe(0);
    expect(readFileSync(state, 'utf8')).toContain('markets www.espn.com 151.101.66.1 ' + T0);
    // An hour later espn answers with one address only, and the old one is kept.
    writeFileSync(dnsFile, 'api.vultrinference.com 45.32.1.1\nwww.espn.com 151.101.2.1\newr1.vultrobjects.com 108.61.0.9\n');
    let r = refresh([], T0 + HOUR);
    expect(r.code, r.err).toBe(0);
    let applied = readFileSync(join(base, 'applied.nft'), 'utf8');
    expect(elements(applied, 'markets')).toEqual(['151.101.2.1', '151.101.66.1']);
    expect(r.out).toContain('cdn.example.com: no answer now, kept its addresses');
    // 6 h after T0, the address seen only at T0 goes; the one seen again at T0+1h stays.
    r = refresh([], T0 + 6 * HOUR);
    applied = readFileSync(join(base, 'applied.nft'), 'utf8');
    expect(elements(applied, 'markets')).toEqual(['151.101.2.1']);
    // With no answers at all for 6 h after the last one (T0+6h), the set is empty and the run says so.
    writeFileSync(dnsFile, '');
    r = refresh([], T0 + 12 * HOUR);
    applied = readFileSync(join(base, 'applied.nft'), 'utf8');
    expect(elements(applied, 'markets')).toEqual([]);
    expect(r.out).toContain('warning: www.espn.com has no address');
  });

  it('drops a host taken off the table at once, and leaves out non-public answers', () => {
    writeFileSync(dnsFile, 'api.vultrinference.com 45.32.1.1\nwww.espn.com 151.101.2.1 10.1.96.5 127.0.0.1 169.254.169.254 172.20.0.1 192.168.1.1 100.64.0.1\n');
    expect(refresh([], T0 + 8 * HOUR).code).toBe(0);
    writeFileSync(hostsFile, 'markets www.espn.com\n');
    const r = refresh([], T0 + 8 * HOUR + 60);
    expect(r.code, r.err).toBe(0);
    const applied = readFileSync(join(base, 'applied.nft'), 'utf8');
    expect(elements(applied, 'models')).toEqual([]);
    expect(elements(applied, 'markets')).toEqual(['151.101.2.1']);
    expect(r.err).toContain('10.1.96.5, not a public address');
    expect(r.err).toContain('169.254.169.254, not a public address');
    expect(readFileSync(state, 'utf8')).not.toContain('api.vultrinference.com');
  });

  it('refuses a bad table before resolving anything', () => {
    writeFileSync(hostsFile, 'runner sandbox.example.com\n');
    expect(refresh(['--dry-run'], T0).err).toMatch(/unknown set 'runner'/);
    writeFileSync(hostsFile, 'markets 10.1.96.5\n');
    expect(refresh(['--dry-run'], T0).err).toMatch(/not a host name/);
    writeFileSync(hostsFile, 'markets a.example.com extra\n');
    expect(refresh(['--dry-run'], T0).code).toBe(2);
  });
});

// The real nft, in a private user+network namespace.
const canNetns = spawnSync('unshare', ['-rn', 'nft', 'list', 'ruleset'], { encoding: 'utf8' }).status === 0;
describe.skipIf(!canNetns)('egress-refresh.sh with the real nft, in a private netns', { timeout: 30_000 }, () => {
  it('control.nft loads, the refill passes nft -c and loads, and the sets hold the addresses', () => {
    const dir = join(base, 'nft');
    execFileSync('mkdir', ['-p', dir]);
    copyFileSync(join(nftDir, 'control.nft'), join(dir, 'control.nft'));
    copyFileSync(join(nftDir, 'example-control-vars.nft'), join(dir, 'control-vars.nft'));
    copyFileSync(join(nftDir, 'egress-enforce.nft'), join(dir, 'control-egress-mode.nft'));
    writeFileSync(hostsFile, 'models api.vultrinference.com\nmarkets www.espn.com\naudit ewr1.vultrobjects.com\n');
    writeFileSync(dnsFile, 'api.vultrinference.com 45.32.1.1\nwww.espn.com 151.101.2.1 151.101.66.1\newr1.vultrobjects.com 108.61.0.9\n');
    rmSync(state, { force: true });
    const steps = [
      `nft -I ${dir} -f ${dir}/control.nft`,
      `bash ${script} --check`,
      `bash ${script}`,
      // A second refill replaces, never adds to, the sets (one transaction each time).
      `bash ${script}`,
      'nft list set inet vha allow_markets',
      'nft list set inet vha allow_audit',
      'nft list set inet vha allow_caddy',
    ].join(' && ');
    const r = spawnSync('unshare', ['-rn', 'bash', '-c', steps], {
      env: { ...process.env, VHA_EGRESS_HOSTS: hostsFile, VHA_EGRESS_STATE: state, VHA_RESOLVE: resolver, VHA_NOW: String(T0) },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('egress-refresh: nft -c passed');
    expect(r.stdout).toMatch(/set allow_markets \{[^}]*elements = \{ 151\.101\.2\.1, 151\.101\.66\.1 \}/);
    expect(r.stdout).toMatch(/set allow_audit \{[^}]*elements = \{ 108\.61\.0\.9 \}/);
    expect(r.stdout).toMatch(/set allow_caddy \{\s*type ipv4_addr\s*\}/);
  });
});
