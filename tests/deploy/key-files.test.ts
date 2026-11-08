/**
 * Every key file, end to end: what deploy/prod-secrets.ts writes under /etc/vha/secrets, where deploy/compose.control.yml
 * mounts it (/run/secrets/<name> in its one container), what the service reads when nothing is set (secretFile in
 * service-kit), and the local path scripts/dev-secrets.ts puts in .env. A change to any one of the four fails here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SERVICES } from '@app/contracts';
import { envKey, s3FromConfig, secretFile, SECRETS_DIR } from '@app/service-kit';
import { UIDS, VALKEY_OWNER, run } from '../../deploy/prod-secrets.ts';
import { RealConfig as AccountsConfig } from '../../services/accounts/src/real.ts';
import { AuditConfig } from '../../services/audit/src/real.ts';
import { ConnectionsConfig } from '../../services/connections/src/real.ts';
import { MarketsConfig } from '../../services/markets/src/real.ts';
import { ModelsConfig } from '../../services/models/src/real.ts';

const root = join(import.meta.dirname, '../..');
const base = mkdtempSync(join(tmpdir(), 'vha-key-files-test-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Each key file: the service, its variable (after the prefix), the name under /run/secrets, the file under /etc/vha/secrets. */
const KEY_FILES = [
  { service: 'accounts', name: 'SESSION_KEY_FILE', file: 'session-key', prod: 'accounts/session-key' },
  { service: 'board', name: 'S3_CREDENTIALS_FILE', file: 's3', prod: 'board/s3' },
  { service: 'markets', name: 'BRAVE_KEY_FILE', file: 'brave-search', prod: 'markets/brave-search' },
  { service: 'connections', name: 'MASTER_KEY_FILE', file: 'connections-master', prod: 'connections/master' },
  { service: 'models', name: 'VULTR_KEY_FILE', file: 'vultr-inference', prod: 'models/vultr-inference' },
  { service: 'audit', name: 'SIGNING_KEY_FILE', file: 'audit-signing-key', prod: 'audit/signing-key' },
  { service: 'audit', name: 'S3_CREDENTIALS_FILE', file: 's3', prod: 'audit/s3' },
] as const;

/** What each service reads when its variable isn't set. */
function s3Default(): string {
  // No credentials file is set, so s3FromConfig opens its default; the error names the path it tried.
  try {
    s3FromConfig({ S3_BUCKET: 'b', S3_ENDPOINT: 'http://127.0.0.1:9' });
  } catch (e) {
    return /'([^']+)'/.exec(String(e))?.[1] ?? String(e);
  }
  return 'no error: a credentials file exists at the default path on this machine';
}
const DEFAULTS: Record<string, () => string> = {
  'accounts.SESSION_KEY_FILE': () => AccountsConfig.parse({}).SESSION_KEY_FILE,
  'board.S3_CREDENTIALS_FILE': s3Default,
  'markets.BRAVE_KEY_FILE': () => MarketsConfig.parse({}).BRAVE_KEY_FILE,
  'connections.MASTER_KEY_FILE': () => ConnectionsConfig.parse({}).MASTER_KEY_FILE,
  'models.VULTR_KEY_FILE': () => ModelsConfig.parse({}).VULTR_KEY_FILE,
  'audit.SIGNING_KEY_FILE': () => AuditConfig.parse({ DATABASE_URL: 'postgres://x', VALKEY_URL: 'redis://x' }).SIGNING_KEY_FILE,
  'audit.S3_CREDENTIALS_FILE': s3Default,
};

// --- compose.control.yml, read as the plain text it is (two-space blocks, one `secrets: [...]` line per service)
const compose = readFileSync(join(root, 'deploy/compose.control.yml'), 'utf8');
const section = (name: string) => {
  const from = compose.indexOf(`\n${name}:\n`);
  const to = compose.slice(from + 1).search(/\n[a-z][\w-]*:\n/);
  return compose.slice(from, to < 0 ? undefined : from + 1 + to);
};
const blocks = new Map(
  section('services')
    .split(/\n(?= {2}[a-z][\w-]*:\n)/)
    .slice(1)
    .map((b) => [/^ {2}([a-z][\w-]*):/.exec(b)![1]!, b] as [string, string]),
);
const mounts = (svc: string) =>
  [...(/\n {4}secrets: \[(.*)\]/.exec(blocks.get(svc) ?? '')?.[1] ?? '').matchAll(/\{ source: ([\w-]+), target: ([\w-]+) \}/g)].map((m) => ({ source: m[1]!, target: m[2]! }));
const sources = new Map(
  [...section('secrets').matchAll(/\n {2}([\w-]+): +\{ file: "\$\{VHA_SECRETS:-\/etc\/vha\/secrets\}\/([^"]+)" \}/g)].map((m) => [m[1]!, m[2]!] as [string, string]),
);

// --- prod-secrets.ts, dry run: the files and their owners
const out = join(base, 'prod');
let printed = '';
const code = run(['--dry-run', '--out', out], { SANDBOX_VPC_IP: '10.10.0.5', PG_HOST: 'pg.example.invalid' }, (s) => (printed += s));
function written(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? written(dir, join(rel, d.name)) : [join(rel, d.name)]));
}
const prodFiles = new Set(written(out));
/** Each file's owner, from the report line `0400 10102:10102 accounts/session-key ...`. */
const owners = new Map([...printed.matchAll(/^ {2}0[0-7]{3} (\d+):(\d+) +(\S+)/gm)].map((m) => [m[3]!, Number(m[1])] as [string, number]));

describe('key files: prod-secrets.ts, compose.control.yml, the services and dev-secrets agree', () => {
  it('compose and prod-secrets were read', () => {
    expect(code, printed).toBe(0);
    expect(blocks.size).toBeGreaterThanOrEqual(SERVICES.length + 2);
    expect(sources.size).toBeGreaterThanOrEqual(KEY_FILES.length + SERVICES.length);
    expect(owners.size).toBe(prodFiles.size - 1); // all but _state/values
  });

  for (const k of KEY_FILES) {
    it(`${k.service} ${envKey(k.service, k.name)}: ${k.prod} -> /run/secrets/${k.file}`, () => {
      // 1 the service reads /run/secrets/<file> by default
      expect(DEFAULTS[`${k.service}.${k.name}`]!()).toBe(secretFile(k.file));
      // 2 compose mounts that file there, in that container only, and sets no variable that overrides the default
      const m = mounts(k.service).find((x) => x.target === k.file);
      expect(m, `compose: ${k.service} mounts nothing at /run/secrets/${k.file}`).toBeTruthy();
      expect(sources.get(m!.source), `compose: secret ${m!.source}`).toBe(k.prod);
      for (const [svc] of blocks) if (svc !== k.service) expect(mounts(svc).map((x) => x.source), svc).not.toContain(m!.source);
      expect(blocks.get(k.service)).not.toMatch(new RegExp(`\\b${envKey(k.service, k.name)}:`));
      // 3 prod-secrets writes it, 0400, owned by that container's uid
      expect(prodFiles.has(k.prod), `prod-secrets doesn't write ${k.prod}`).toBe(true);
      expect(statSync(join(out, k.prod)).mode & 0o777).toBe(0o400);
      expect(owners.get(k.prod)).toBe(UIDS[k.service]);
    });
  }

  it('each service reads its own env file, and every secret compose mounts is a file prod-secrets writes (and back)', () => {
    for (const s of SERVICES) {
      expect(blocks.get(s), s).toContain('"--env-file=/run/secrets/env"');
      expect(sources.get(mounts(s).find((x) => x.target === 'env')!.source)).toBe(`${s}/env`);
      expect(owners.get(`${s}/env`)).toBe(UIDS[s]);
    }
    const mounted = new Set<string>();
    for (const [svc, block] of blocks) {
      for (const m of mounts(svc)) {
        const rel = sources.get(m.source);
        expect(rel, `${svc}: secret ${m.source} has no file`).toBeTruthy();
        expect(prodFiles.has(rel!), `${svc} mounts ${rel}, which prod-secrets doesn't write`).toBe(true);
        const uid = Number(/\n {4}user: "(\d+):/.exec(block)?.[1] ?? 0);
        expect(owners.get(rel!), `${rel}'s owner is ${svc}'s user`).toBe(uid);
        mounted.add(rel!);
      }
    }
    expect(owners.get('valkey/users.acl')).toBe(VALKEY_OWNER.uid);
    // Not mounted on control: the state (root only) and sandbox-manager's caller list (a check of the VX1's own).
    expect([...prodFiles].filter((f) => !mounted.has(f)).sort()).toEqual(['_state/values', 'sandbox-manager/env']);
    expect([...sources.values()].filter((f) => !prodFiles.has(f))).toEqual([]);
  });

  it('every secretFile(...) in the services and service-kit is listed above', () => {
    const listed = new Set(KEY_FILES.map((k) => k.file));
    const dirs = [...SERVICES.map((s) => join(root, 'services', s, 'src')), join(root, 'packages/service-kit/src')];
    const used = dirs.flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.endsWith('.ts'))
        .flatMap((f) => [...readFileSync(join(d, f), 'utf8').matchAll(/secretFile\('([\w-]+)'\)/g)].map((m) => m[1]!)),
    );
    expect(used.length).toBeGreaterThanOrEqual(6);
    for (const f of used) expect(listed, `secretFile('${f}') is not in KEY_FILES`).toContain(f);
    expect(SECRETS_DIR).toBe('/run/secrets');
  });

  it('dev-secrets puts a local path in .env for every key file except the S3 pair (no bucket in dev)', () => {
    const dev = join(base, 'dev');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/dev-secrets.ts', '--out', dev], {
      cwd: root,
      env: { ...process.env, MODELS_VULTR_KEY_FILE: '', MARKETS_BRAVE_KEY_FILE: '' },
      encoding: 'utf8',
    });
    const env = new Map(
      readFileSync(join(dev, '.env'), 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z]/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as [string, string]),
    );
    for (const k of KEY_FILES) {
      const v = env.get(envKey(k.service, k.name));
      if (k.name === 'S3_CREDENTIALS_FILE') {
        expect(v, 'dev has no bucket').toBeUndefined();
        continue;
      }
      expect(v && isAbsolute(v) && v.startsWith(dev) && !v.startsWith(SECRETS_DIR), `${envKey(k.service, k.name)}=${v}`).toBe(true);
    }
    // The keys dev-secrets makes exist; the two handed-in ones are absent until someone puts a key there.
    for (const k of ['ACCOUNTS_SESSION_KEY_FILE', 'AUDIT_SIGNING_KEY_FILE', 'CONNECTIONS_MASTER_KEY_FILE']) expect(existsSync(env.get(k)!), k).toBe(true);
    expect(env.get('MODELS_VULTR_KEY_FILE')).toBe(join(dev, 'deploy/.dev/vultr-inference'));
    expect(env.get('MARKETS_BRAVE_KEY_FILE')).toBe(join(dev, 'deploy/.dev/brave-search'));
  }, 30_000);
});
