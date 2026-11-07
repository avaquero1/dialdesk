/**
 * deploy/egress-hosts.ts: each control container's allowed hosts. The fixed hosts match the base URLs in the
 * services' own code, every production feed's host is on markets' list and no fixture host is, the S3 endpoint
 * goes to audit and board only, and the set names agree with control.nft and egress-refresh.sh.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROD_SOURCE_ROWS, SOURCE_CATALOG, type SourceRow } from '@app/contracts';
import { KALSHI_BASES } from '../../services/connections/src/kalshi.ts';
import { POLYMARKET_DATA_API } from '../../services/connections/src/polymarket.ts';
import { BRAVE_NEWS } from '../../services/markets/src/brave.ts';
import { KALSHI_BASE } from '../../services/markets/src/kalshi.ts';
import { CLOB_BASE, GAMMA_BASE } from '../../services/markets/src/polymarket.ts';
import { EGRESS_SETS, egressHosts, feedHosts, render, run, s3Host } from '../../deploy/egress-hosts.ts';

const root = join(import.meta.dirname, '../..');
const host = (url: string) => new URL(url).hostname;
const S3 = { S3_ENDPOINT: 'https://ewr1.vultrobjects.com' };

describe('egress-hosts', () => {
  it('lists the hosts in each service code base URL', () => {
    const t = egressHosts(S3);
    const modelsDefault = /VULTR_BASE_URL: z\.string\(\)\.url\(\)\.default\('([^']+)'\)/.exec(
      readFileSync(join(root, 'services/models/src/real.ts'), 'utf8'),
    )?.[1];
    expect(modelsDefault).toBeDefined();
    expect(t.models).toEqual([host(modelsDefault!)]);
    for (const u of [KALSHI_BASE, GAMMA_BASE, CLOB_BASE, BRAVE_NEWS]) expect(t.markets).toContain(host(u));
    expect(t.connections).toEqual([host(KALSHI_BASES.demo), host(KALSHI_BASES.prod), host(POLYMARKET_DATA_API)].sort());
    expect(t.caddy).toEqual(['acme-v02.api.letsencrypt.org']);
  });

  it('gives markets every production feed host, and no fixture host', () => {
    const t = egressHosts({});
    const prodFeeds = PROD_SOURCE_ROWS.flatMap((r) => r.feeds.map((f) => host(f.url)));
    expect(prodFeeds.length).toBeGreaterThan(30);
    for (const h of prodFeeds) expect(t.markets).toContain(h);
    const fixtureFeeds = SOURCE_CATALOG.rows.filter((r) => r.env === 'fixture').flatMap((r) => r.feeds.map((f) => host(f.url)));
    for (const h of fixtureFeeds) expect(Object.values(t).flat()).not.toContain(h);
    // The fixture rows in the catalog are skipped even when passed in.
    expect(feedHosts(SOURCE_CATALOG.rows).sort()).toEqual([...new Set(prodFeeds)].sort());
  });

  it('puts the S3 endpoint on audit and board only; none without S3_ENDPOINT', () => {
    const t = egressHosts(S3);
    expect(t.audit).toEqual(['ewr1.vultrobjects.com']);
    expect(t.board).toEqual(['ewr1.vultrobjects.com']);
    for (const set of ['caddy', 'models', 'markets', 'connections'] as const) expect(t[set]).not.toContain('ewr1.vultrobjects.com');
    const none = egressHosts({});
    expect(none.audit).toEqual([]);
    expect(none.board).toEqual([]);
    expect(render(none, {})).toContain('No S3_ENDPOINT');
  });

  it('refuses an endpoint or feed that is not https on 443, and anything that is not a host name', () => {
    expect(() => s3Host('http://ewr1.vultrobjects.com')).toThrow(/https/);
    expect(() => s3Host('https://ewr1.vultrobjects.com:9000')).toThrow(/443/);
    expect(() => s3Host('https://10.1.96.9')).not.toThrow();
    expect(() => egressHosts({ S3_ENDPOINT: 'https://10.1.96.9' })).toThrow(/not a plain host name/);
    const row = (url: string): SourceRow => ({ ...PROD_SOURCE_ROWS[0]!, source_id: 'src-test', feeds: [{ url, kind: 'rss' }] });
    expect(() => feedHosts([row('http://plain.example.com/rss')])).toThrow(/not https/);
    expect(() => feedHosts([row('https://odd.example.com:8443/rss')])).toThrow(/443/);
  });

  it('renders sorted `<set> <host>` lines with no duplicates', () => {
    const lines = render(egressHosts(S3), S3)
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    for (const l of lines) expect(l).toMatch(/^(caddy|models|markets|connections|audit|board) [a-z0-9.-]+$/);
    expect(new Set(lines).size).toBe(lines.length);
    for (const set of EGRESS_SETS) {
      const hosts = lines.filter((l) => l.startsWith(`${set} `)).map((l) => l.slice(set.length + 1));
      expect(hosts).toEqual([...hosts].sort());
    }
  });

  it('names the same sets as control.nft and egress-refresh.sh', () => {
    const nft = readFileSync(join(root, 'deploy/nftables/control.nft'), 'utf8');
    expect([...nft.matchAll(/set allow_([a-z]+) \{/g)].map((m) => m[1]).sort()).toEqual([...EGRESS_SETS].sort());
    const sh = readFileSync(join(root, 'deploy/nftables/egress-refresh.sh'), 'utf8');
    expect(/^SETS="([a-z ]+)"/m.exec(sh)?.[1]?.split(' ')).toEqual([...EGRESS_SETS]);
  });

  it('runs as a CLI: exit 0 with the table on stdout, exit 1 with the reason on stderr', () => {
    let out = '';
    let err = '';
    expect(run(S3, (s) => (out += s), (s) => (err += s))).toBe(0);
    expect(out).toContain('audit ewr1.vultrobjects.com');
    expect(run({ S3_ENDPOINT: 'http://x.example.com' }, (s) => (out += s), (s) => (err += s))).toBe(1);
    expect(err).toMatch(/https/);
    const cli = execFileSync('npx', ['tsx', 'deploy/egress-hosts.ts'], { cwd: root, env: { ...process.env, ...S3 }, encoding: 'utf8' });
    expect(cli).toBe(render(egressHosts(S3), S3));
    // A fresh npx + tsx start: seconds on a loaded build box.
  }, 30_000);
});
