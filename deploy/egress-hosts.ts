/**
 * The egress table: the hosts each control container should reach on 443 (architecture.md, "Control's outbound traffic").
 * The live deploy is log-only: a call off a list is logged and still goes out (deploy/README.md).
 * deploy/nftables/control.nft has one set per container (`allow_<name>`); deploy/nftables/egress-refresh.sh (a timer)
 * resolves the hosts in the file this script writes and refills those sets.
 *
 * Runs in the app image (deploy.sh does this, with deploy.env for S3_ENDPOINT):
 *   docker run --rm --env-file /etc/vha/deploy.env vha/app:<tag> node --import tsx deploy/egress-hosts.ts \
 *     > /etc/vha/nft/egress-hosts.txt
 *
 * Output: one `<set> <host>` line per host, sorted, `#` comments on top. The host list is public (no secrets).
 *
 * - caddy: Let's Encrypt (ACME).
 * - models: Vultr Serverless Inference.
 * - markets: Kalshi's and Polymarket's public market data, Brave Search, and the host of every feed in PROD_SOURCE_ROWS.
 * - connections: Kalshi (prod and its demo exchange) and Polymarket's Data API.
 * - audit, board: the Object Storage endpoint (S3_ENDPOINT; path-style, so one host for both buckets). Without it they
 *   keep their local folders and their sets stay empty.
 * - runner reaches only sandbox-manager over the VPC, and accounts and agent only Postgres: control.nft has those rules
 *   by address, so they have no set here.
 *
 * A feed or API that redirects to another host (a CDN) shows up in the log-only mode's kernel log
 * ("vha-egress-would-drop"): add that host here before switching to enforce.
 */
import { pathToFileURL } from 'node:url';
import { Domain, PROD_SOURCE_ROWS, type SourceRow } from '@app/contracts';

export const EGRESS_SETS = ['caddy', 'models', 'markets', 'connections', 'audit', 'board'] as const;
export type EgressSet = (typeof EGRESS_SETS)[number];

/** The fixed hosts. tests/deploy/egress-hosts.test.ts checks them against the base URLs in each service's code. */
export const STATIC_HOSTS: Record<EgressSet, string[]> = {
  caddy: ['acme-v02.api.letsencrypt.org'],
  models: ['api.vultrinference.com'],
  markets: ['api.elections.kalshi.com', 'gamma-api.polymarket.com', 'clob.polymarket.com', 'api.search.brave.com'],
  connections: ['external-api.kalshi.com', 'external-api.demo.kalshi.co', 'data-api.polymarket.com'],
  audit: [],
  board: [],
};

/** The host of every production feed. Only https feeds: the containers may reach 443 and nothing else. */
export function feedHosts(rows: SourceRow[] = PROD_SOURCE_ROWS): string[] {
  const hosts = new Set<string>();
  for (const row of rows) {
    if (row.env !== 'prod') continue;
    for (const feed of row.feeds) {
      const u = new URL(feed.url);
      if (u.protocol !== 'https:') throw new Error(`egress-hosts: ${row.source_id}'s feed ${feed.url} is not https`);
      if (u.port && u.port !== '443') throw new Error(`egress-hosts: ${row.source_id}'s feed ${feed.url} is not on 443`);
      hosts.add(u.hostname);
    }
  }
  return [...hosts];
}

/** The Object Storage host from S3_ENDPOINT (e.g. https://ewr1.vultrobjects.com), or null when it isn't set. */
export function s3Host(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  const u = new URL(endpoint);
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) {
    throw new Error(`egress-hosts: S3_ENDPOINT must be https on 443 (the containers reach nothing else): ${endpoint}`);
  }
  return u.hostname;
}

/** Each set's hosts, sorted and without duplicates. Every host must be a plain DNS name (no address, no wildcard). */
export function egressHosts(env: Record<string, string | undefined>, rows: SourceRow[] = PROD_SOURCE_ROWS): Record<EgressSet, string[]> {
  const s3 = s3Host(env.S3_ENDPOINT);
  const table: Record<EgressSet, string[]> = {
    caddy: STATIC_HOSTS.caddy,
    models: STATIC_HOSTS.models,
    markets: [...STATIC_HOSTS.markets, ...feedHosts(rows)],
    connections: STATIC_HOSTS.connections,
    audit: s3 ? [s3] : [],
    board: s3 ? [s3] : [],
  };
  for (const set of EGRESS_SETS) {
    table[set] = [...new Set(table[set])].sort();
    for (const host of table[set]) {
      if (!Domain.safeParse(host).success) throw new Error(`egress-hosts: ${set}: not a plain host name: ${host}`);
    }
  }
  return table;
}

/** The file egress-refresh.sh reads. */
export function render(table: Record<EgressSet, string[]>, env: Record<string, string | undefined>): string {
  const lines = [
    '# The egress table: <set> <host>. Written by deploy/egress-hosts.ts; read by egress-refresh.sh, which fills',
    '# the nft set inet vha allow_<set> with the addresses of each host.',
  ];
  if (!env.S3_ENDPOINT) lines.push('# No S3_ENDPOINT: audit and board keep their local folders, so their sets stay empty.');
  for (const set of EGRESS_SETS) for (const host of table[set]) lines.push(`${set} ${host}`);
  return lines.join('\n') + '\n';
}

export function run(env: Record<string, string | undefined>, print: (s: string) => void, printError = print): number {
  try {
    print(render(egressHosts(env), env));
    return 0;
  } catch (err) {
    printError(`${(err as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(
    process.env,
    (s) => process.stdout.write(s),
    (s) => process.stderr.write(s),
  );
}
