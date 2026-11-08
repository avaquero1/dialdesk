/**
 * deploy/prod-secrets.ts in dry-run mode (no root, no chown): every container's files are written with the right modes,
 * every caller's token matches its callee's hash, the Valkey ACL and the DB URLs agree with the passwords, values are
 * kept across runs, and the printed report holds no value from any file it wrote.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DATA_SERVICES, SERVICES, callGraph, valkeyUser } from '@app/contracts';
import { envKey, hashToken } from '@app/service-kit';
import { UIDS, run } from '../../deploy/prod-secrets.ts';

const root = join(import.meta.dirname, '../..');
const base = mkdtempSync(join(tmpdir(), 'vha-prod-secrets-test-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ENV = { SANDBOX_VPC_IP: '10.10.0.5', PG_HOST: 'vultr-prod-pg.internal', PG_PORT: '16751', PG_DATABASE: 'defaultdb' };
function dry(out: string, extra: string[] = [], env: Record<string, string> = ENV) {
  let printed = '';
  const code = run(['--dry-run', '--out', out, ...extra], env, (s) => (printed += s));
  return { code, printed };
}
const kv = (p: string) =>
  new Map(
    readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as [string, string]),
  );
function allFiles(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? allFiles(dir, join(rel, d.name)) : [join(rel, d.name)],
  );
}
/** Every value a file holds: each env value, each line of the other files. */
function valuesIn(out: string): string[] {
  return allFiles(out).flatMap((f) =>
    readFileSync(join(out, f), 'utf8')
      .split('\n')
      .map((l) => (f.endsWith('env') || f.endsWith('values') ? l.slice(l.indexOf('=') + 1) : l).trim())
      .filter((v) => v.length >= 8 && !v.startsWith('-----') && !v.startsWith('#')),
  );
}

describe('deploy/prod-secrets.ts', () => {
  const out = join(base, 'a');
  const first = dry(out);

  it('writes every container\'s files, 0400 each, in 0700 folders, and prints no value', () => {
    expect(first.code, first.printed).toBe(0);
    const files = allFiles(out).sort();
    for (const s of SERVICES) expect(files).toContain(`${s}/env`);
    for (const f of ['accounts/session-key', 'audit/signing-key', 'audit/s3', 'board/s3', 'connections/master', 'markets/brave-search',
      'models/vultr-inference', 'valkey/users.acl', 'valkey/health', 'postgres/env', 'sandbox-manager/env', '_state/values']) {
      expect(files).toContain(f);
    }
    for (const f of files) {
      expect(statSync(join(out, f)).mode & 0o777, f).toBe(f === '_state/values' ? 0o600 : 0o400);
      expect(statSync(join(out, f, '..')).mode & 0o777, f).toBe(0o700);
    }
    const values = valuesIn(out);
    expect(values.length).toBeGreaterThan(50);
    for (const v of values) expect(first.printed.includes(v), 'a value was printed').toBe(false);
    expect(first.printed).toMatch(/EMPTY: no Vultr Serverless Inference key/);
  });

  it('every caller holds a token whose hash its callee holds; runner reaches sandbox-manager on the VPC', () => {
    const graph = callGraph() as Record<string, string[]>;
    graph.runner = [...(graph.runner ?? []), 'sandbox-manager'];
    for (const [caller, callees] of Object.entries(graph)) {
      if (caller === 'browser' || caller === 'public') continue;
      const mine = kv(join(out, caller, 'env'));
      for (const callee of callees) {
        const t = mine.get(envKey(caller, `TOKEN_${callee.toUpperCase().replace(/-/g, '_')}`));
        expect(t, `${caller} -> ${callee}`).toBeTruthy();
        const theirs = callee === 'sandbox-manager' ? kv(join(out, 'sandbox-manager/env')).get('SANDBOX_MANAGER_CALLERS') : kv(join(out, callee, 'env')).get(envKey(callee, 'CALLERS'));
        expect(theirs!.split(',')).toContain(`${caller}:${hashToken(t!)}`);
      }
    }
    expect(kv(join(out, 'runner/env')).get('RUNNER_URL_SANDBOX_MANAGER')).toBe('http://10.10.0.5:8200');
    expect(kv(join(out, 'agent/env')).get('AGENT_URL_MODELS')).toBe('http://models:8107');
    expect(readFileSync(join(out, 'sandbox-manager/env'), 'utf8')).not.toMatch(/TOKEN/);
  });

  it("runner's sandbox-manager token can come from the sandbox machine (SANDBOX_MANAGER_TOKEN_FILE)", () => {
    const o = join(base, 'sbx-token');
    const file = join(base, 'runner-token');
    const token = 'ab'.repeat(32);
    writeFileSync(file, token + '\n');
    const r = dry(o, [], { ...ENV, SANDBOX_MANAGER_TOKEN_FILE: file });
    expect(r.code).toBe(0);
    expect(kv(join(o, 'runner/env')).get('RUNNER_TOKEN_SANDBOX_MANAGER')).toBe(token);
    expect(kv(join(o, 'sandbox-manager/env')).get('SANDBOX_MANAGER_CALLERS')).toBe(`runner:${hashToken(token)}`);
    expect(r.printed).not.toContain(token);
    writeFileSync(file, 'short\n');
    const bad = dry(join(base, 'sbx-token-bad'), [], { ...ENV, SANDBOX_MANAGER_TOKEN_FILE: file });
    expect(bad.code).not.toBe(0);
    expect(bad.printed).toMatch(/SANDBOX_MANAGER_TOKEN_FILE: .* is not a token/);
  });

  it('DB URLs use TLS and the passwords db-init gets; Valkey URLs match the ACL', () => {
    const pg = kv(join(out, 'postgres/env'));
    for (const s of DATA_SERVICES) {
      const url = new URL(kv(join(out, s, 'env')).get(envKey(s, 'DATABASE_URL'))!);
      expect(url.hostname).toBe('vultr-prod-pg.internal');
      expect(url.port).toBe('16751');
      expect(url.pathname).toBe('/defaultdb');
      expect(url.searchParams.get('sslmode')).toBe('require');
      expect(url.username).toBe(`svc_${s}`);
      expect(url.password).toBe(pg.get(`DB_PASSWORD_${s.toUpperCase()}`));
    }
    expect(kv(join(out, 'edge/env')).has('EDGE_DATABASE_URL')).toBe(false);
    const acl = readFileSync(join(out, 'valkey/users.acl'), 'utf8');
    expect(acl).toMatch(/^user default off$/m);
    for (const s of SERVICES) {
      const url = new URL(kv(join(out, s, 'env')).get(envKey(s, 'VALKEY_URL'))!);
      expect(url.host).toBe('valkey:6379');
      expect(acl).toContain(`user ${valkeyUser(s)} on >${url.password} `);
    }
    expect(acl).toContain(`user health on >${readFileSync(join(out, 'valkey/health'), 'utf8')} `);
    // edge gets the public half of accounts' session key.
    expect(kv(join(out, 'edge/env')).get('EDGE_SESSION_PUBLIC_KEYS')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('a second run keeps every value; --rotate changes tokens and passwords but keeps the keys', () => {
    const before = new Map(allFiles(out).map((f) => [f, readFileSync(join(out, f), 'utf8')]));
    expect(dry(out).code).toBe(0);
    for (const [f, body] of before) expect(readFileSync(join(out, f), 'utf8'), f).toBe(body);
    const r = dry(out, ['--rotate']);
    expect(r.code).toBe(0);
    expect(r.printed).toMatch(/--rotate/);
    expect(readFileSync(join(out, 'runner/env'), 'utf8')).not.toBe(before.get('runner/env'));
    expect(readFileSync(join(out, 'postgres/env'), 'utf8')).not.toBe(before.get('postgres/env'));
    for (const f of ['accounts/session-key', 'audit/signing-key', 'connections/master']) expect(readFileSync(join(out, f), 'utf8')).toBe(before.get(f));
    const pubBefore = /EDGE_SESSION_PUBLIC_KEYS=(\S+)/.exec(before.get('edge/env')!)?.[1];
    expect(kv(join(out, 'edge/env')).get('EDGE_SESSION_PUBLIC_KEYS')).toBe(pubBefore);
  });

  it('copies handed-in files (an S3 key is checked first) and never prints them', () => {
    const o = join(base, 'b');
    const inputs = mkdtempSync(join(base, 'in-'));
    writeFileSync(join(inputs, 's3'), 'access_key_id=AKIAEXAMPLE1234567\nsecret_access_key=SeCrEtExAmPlEvAlUe0987654321\n');
    writeFileSync(join(inputs, 'inference'), 'VULTRINFERENCEEXAMPLEKEY000111\n');
    const env = { ...ENV, S3_SCREENSHOTS_CREDENTIALS: join(inputs, 's3'), VULTR_INFERENCE_KEY_FILE: join(inputs, 'inference') };
    const r = dry(o, [], env);
    expect(r.code, r.printed).toBe(0);
    expect(readFileSync(join(o, 'board/s3'), 'utf8')).toContain('SeCrEtExAmPlEvAlUe0987654321');
    expect(readFileSync(join(o, 'audit/s3'), 'utf8')).toContain('SeCrEtExAmPlEvAlUe0987654321');
    expect(readFileSync(join(o, 'models/vultr-inference'), 'utf8')).toBe('VULTRINFERENCEEXAMPLEKEY000111\n');
    for (const v of ['AKIAEXAMPLE1234567', 'SeCrEtExAmPlEvAlUe0987654321', 'VULTRINFERENCEEXAMPLEKEY000111']) expect(r.printed).not.toContain(v);
    // A broken S3 key file is refused before anything is written.
    writeFileSync(join(inputs, 's3'), 'secret_access_key=only\n');
    const bad = dry(join(base, 'c'), [], env);
    expect(bad.code).toBe(1);
    expect(bad.printed).toMatch(/nothing written:[\s\S]*needs access_key_id/);
  });

  it('--local-db points at the fallback container without TLS; a missing input stops a real run', () => {
    const o = join(base, 'd');
    expect(dry(o, ['--local-db'], { SANDBOX_VPC_IP: '10.10.0.5' }).code).toBe(0);
    expect(kv(join(o, 'board/env')).get('BOARD_DATABASE_URL')).toMatch(/^postgres:\/\/svc_board:[^@]+@postgres:5432\/app$/);
    const r = dry(join(base, 'e'), [], {});
    expect(r.code).toBe(0);
    expect(r.printed).toMatch(/placeholders \(dry run only\): SANDBOX_VPC_IP, PG_HOST/);
  });

  it('its uids are compose.control.yml\'s', () => {
    const compose = readFileSync(join(root, 'deploy/compose.control.yml'), 'utf8');
    for (const [s, uid] of Object.entries(UIDS)) {
      expect(new RegExp(`\\n  ${s}:\\n    <<: \\*app\\n    user: "${uid}:${uid}"`).test(compose), s).toBe(true);
    }
  });

  it('the CLI dry run (temp folder, removed afterwards) exits 0', () => {
    const txt = execFileSync(process.execPath, ['--import', 'tsx', 'deploy/prod-secrets.ts', '--dry-run'], {
      cwd: root,
      env: { ...process.env, ...ENV },
      encoding: 'utf8',
    });
    expect(txt).toMatch(/DRY RUN, wrote 20 files to <a temp folder, removed below>/);
    expect(txt).toMatch(/removed the dry run's temp folder/);
    // A fresh node + tsx start: seconds on a loaded build box.
  }, 30_000);
});
