/**
 * Writes the production secret files that deploy/compose.control.yml mounts (and sandbox-manager's caller list, a
 * check against the sandbox machine's own). The production twin of scripts/dev-secrets.ts: the same tokens and caller graph (callGraph,
 * valkeyAclRule), but one folder per container under the output folder, each file owned by that container's uid with
 * mode 0400 and each folder root-only (0700).
 *
 * Runs ON control, as root, in the app image (deploy.sh does this):
 *   docker run --rm --env-file /etc/vha/deploy.env -v /etc/vha/secrets:/out vha/app:<tag> \
 *     node --import tsx deploy/prod-secrets.ts --out /out
 *
 *   --out DIR    where to write (default /etc/vha/secrets)
 *   --dry-run    no chown, no root needed; without --out it writes to a new temp folder and removes it afterwards.
 *                Prints the files, owners, modes and variable names. Never a value.
 *   --rotate     new tokens and passwords (then run db-init.sql again and restart every service). The session, audit
 *                and master keys are always kept: delete a key's file to replace it.
 *   --local-db   every DATABASE_URL points at the fallback Postgres container (postgres:5432, no TLS).
 *
 * Inputs, from the environment (deploy.env):
 *   PG_HOST, PG_PORT (5432), PG_DATABASE (app)    Managed Postgres over the VPC; the URLs carry sslmode=require
 *   SANDBOX_VPC_IP                                  the VX1's VPC address: runner calls sandbox-manager on :8200
 *   S3_SCREENSHOTS_CREDENTIALS, S3_HEADS_CREDENTIALS, VULTR_INFERENCE_KEY_FILE, BRAVE_KEY_FILE
 *                                                   files to copy in (when set); else an existing copy is kept, or an
 *                                                   empty file is written and named in the output
 *   SANDBOX_MANAGER_TOKEN_FILE                      runner's token for sandbox-manager, made on the sandbox machine
 *                                                   (deploy/sandbox-host/setup.sh, /etc/vha/runner-token; deploy.sh
 *                                                   copies it here). Without it, a token is made here as for the others
 * Every value it makes is kept in <out>/_state/values (root, 0600), so a second run changes nothing unless --rotate.
 * Before it prints, it checks its own output against every value it wrote, and exits 1 instead of printing one.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_SERVICES, PORTS, SERVICES, callGraph, valkeyAclRule, valkeyUser, type ServiceName } from '@app/contracts';
import { envKey, hashToken, readS3Credentials } from '@app/service-kit';

/** Each container's uid (= gid), as in compose.control.yml's `user:` lines. tests/deploy checks they match. */
export const UIDS: Record<ServiceName, number> = {
  edge: 10101,
  accounts: 10102,
  board: 10103,
  agent: 10104,
  runner: 10105,
  markets: 10106,
  connections: 10107,
  models: 10108,
  audit: 10109,
};
export const VALKEY_OWNER = { uid: 999, gid: 1000 };
const ROOT = { uid: 0, gid: 0 };

type Env = Record<string, string | undefined>;
type File = { path: string; body: string; uid: number; gid: number; mode: number; note?: string; names?: string[] };

const tag = (s: string) => s.toUpperCase().replace(/-/g, '_');
const secret = () => randomBytes(32).toString('base64url');

function readKv(path: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) m.set(line.slice(0, i), line.slice(i + 1));
  }
  return m;
}

export function run(argv: string[], env: Env, print: (s: string) => void): number {
  const flag = (f: string) => argv.includes(f);
  const opt = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dry = flag('--dry-run');
  const rotate = flag('--rotate');
  const localDb = flag('--local-db');
  const tempOut = dry && !opt('--out');
  const out = opt('--out') ?? (dry ? mkdtempSync(join(tmpdir(), 'vha-prod-secrets-')) : '/etc/vha/secrets');
  const problems: string[] = [];
  const placeholders: string[] = [];
  if (!dry && process.getuid?.() !== 0) {
    print('prod-secrets: run as root (it gives each file to its container\'s uid), or pass --dry-run\n');
    return 2;
  }
  const need = (name: string, example: string) => {
    const v = env[name];
    if (v) return v;
    if (dry) {
      placeholders.push(name);
      return example;
    }
    problems.push(`${name} is not set`);
    return example;
  };

  try {
    // --- values: kept across runs in _state/values unless --rotate
    const statePath = join(out, '_state/values');
    const state = rotate ? new Map<string, string>() : readKv(statePath);
    const value = (k: string) => {
      let v = state.get(k);
      if (!v) state.set(k, (v = secret()));
      return v;
    };

    const graph = callGraph() as Record<string, string[]>;
    graph.runner = [...(graph.runner ?? []), 'sandbox-manager'];
    const envs = new Map<string, string[]>(SERVICES.map((s) => [s, []]));
    const callers: Record<string, string[]> = {};

    const vpcIp = need('SANDBOX_VPC_IP', '192.0.2.10');
    // The sandbox machine makes runner's token and keeps only its hash; runner gets the token from its file.
    const sbxTokenFile = env.SANDBOX_MANAGER_TOKEN_FILE;
    if (sbxTokenFile) {
      const t = existsSync(sbxTokenFile) ? readFileSync(sbxTokenFile, 'utf8').trim() : '';
      if (/^[A-Za-z0-9_-]{32,}$/.test(t)) state.set('token.runner.sandbox-manager', t);
      else problems.push(`SANDBOX_MANAGER_TOKEN_FILE: ${sbxTokenFile} ${t ? 'is not a token (32+ letters, digits, - or _)' : 'is missing or empty'}`);
    }
    for (const [caller, callees] of Object.entries(graph)) {
      if (caller === 'browser' || caller === 'public') continue;
      for (const callee of callees) {
        const t = value(`token.${caller}.${callee}`);
        const url = callee === 'sandbox-manager' ? `http://${vpcIp}:${PORTS['sandbox-manager']}` : `http://apps-${callee}:${PORTS[callee as ServiceName]}`;
        envs.get(caller)!.push(`${envKey(caller, `TOKEN_${tag(callee)}`)}=${t}`, `${envKey(caller, `URL_${tag(callee)}`)}=${url}`);
        (callers[callee] ??= []).push(`${caller}:${hashToken(t)}`);
      }
    }
    for (const [callee, list] of Object.entries(callers)) envs.get(callee)?.push(`${envKey(callee, 'CALLERS')}=${list.join(',')}`);

    // Postgres: Managed (TLS) over the VPC, or the local fallback container.
    const pg = localDb
      ? { host: 'postgres', port: '5432', db: 'app', q: '' }
      : { host: need('PG_HOST', 'pg.example.invalid'), port: env.PG_PORT || '5432', db: env.PG_DATABASE || 'app', q: '?sslmode=require' };
    const pgEnv = [`POSTGRES_PASSWORD=${value('pg.superuser')}`];
    for (const s of DATA_SERVICES) {
      const pw = value(`db.${s}`);
      pgEnv.push(`DB_PASSWORD_${tag(s)}=${pw}`);
      envs.get(s)!.push(`${envKey(s, 'DATABASE_URL')}=postgres://svc_${s}:${pw}@${pg.host}:${pg.port}/${pg.db}${pg.q}`);
    }

    // Valkey: one ACL user per service, plus `health` for the container's healthcheck.
    const health = value('valkey.health');
    const acl = ['user default off', `user health on >${health} resetkeys -@all +ping`];
    for (const s of SERVICES) {
      const pw = value(`valkey.${s}`);
      envs.get(s)!.push(`${envKey(s, 'VALKEY_URL')}=redis://${valkeyUser(s)}:${pw}@valkey:6379`);
      acl.push(`user ${valkeyUser(s)} on >${pw} ${valkeyAclRule(s)}`);
    }

    // Keys: made once, then always kept (delete the file to replace one).
    const keep = (rel: string, make: () => string) => {
      const p = join(out, rel);
      return existsSync(p) && readFileSync(p, 'utf8').trim() ? readFileSync(p, 'utf8') : make();
    };
    const pem = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const sessionPem = keep('accounts/session-key', pem);
    const sessionPub = createPublicKey(createPrivateKey(sessionPem)).export({ format: 'jwk' }).x as string;
    envs.get('edge')!.push(`EDGE_SESSION_PUBLIC_KEYS=${sessionPub}`);
    const auditPem = keep('audit/signing-key', pem);
    const master = keep('connections/master', () => randomBytes(32).toString('base64') + '\n');

    // Files handed in by the operator or deploy.sh: copied when given, else an existing copy is kept, else empty.
    const copied = (rel: string, src: string | undefined, what: string, check?: (p: string) => void) => {
      if (src) {
        if (!existsSync(src)) {
          problems.push(`${what}: ${src} does not exist`);
          return { body: '' };
        }
        try {
          check?.(src);
        } catch (e) {
          problems.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
          return { body: '' };
        }
        return { body: readFileSync(src, 'utf8') };
      }
      const p = join(out, rel);
      if (existsSync(p) && readFileSync(p, 'utf8').trim()) return { body: readFileSync(p, 'utf8'), note: 'kept' };
      return { body: '', note: `EMPTY: ${what}` };
    };
    const s3check = (p: string) => void readS3Credentials(p);
    const boardS3 = copied('board/s3', env.S3_SCREENSHOTS_CREDENTIALS, 'no screenshots bucket key (board keeps its local folder)', s3check);
    const auditS3 = copied('audit/s3', env.S3_HEADS_CREDENTIALS ?? env.S3_SCREENSHOTS_CREDENTIALS, 'no heads bucket key (audit keeps its write-once folder)', s3check);
    const inference = copied('models/vultr-inference', env.VULTR_INFERENCE_KEY_FILE, 'no Vultr Serverless Inference key yet (deploy.sh copies it in)');
    const brave = copied('markets/brave-search', env.BRAVE_KEY_FILE, 'no Brave key (markets skips Brave)');

    const own = (s: ServiceName) => ({ uid: UIDS[s], gid: UIDS[s], mode: 0o400 });
    const files: File[] = [];
    for (const s of SERVICES) {
      const lines = envs.get(s)!;
      files.push({ path: `${s}/env`, body: `# Written by deploy/prod-secrets.ts for ${s}. Never copy it off this machine.\n${lines.join('\n')}\n`, ...own(s), names: lines.map((l) => l.slice(0, l.indexOf('='))) });
    }
    files.push(
      { path: 'accounts/session-key', body: sessionPem, ...own('accounts') },
      { path: 'audit/signing-key', body: auditPem, ...own('audit') },
      { path: 'connections/master', body: master, ...own('connections') },
      { path: 'board/s3', body: boardS3.body, note: boardS3.note, ...own('board') },
      { path: 'audit/s3', body: auditS3.body, note: auditS3.note, ...own('audit') },
      { path: 'models/vultr-inference', body: inference.body, note: inference.note, ...own('models') },
      { path: 'markets/brave-search', body: brave.body, note: brave.note, ...own('markets') },
      { path: 'valkey/users.acl', body: acl.join('\n') + '\n', ...VALKEY_OWNER, mode: 0o400 },
      { path: 'valkey/health', body: health, ...VALKEY_OWNER, mode: 0o400 },
      { path: 'postgres/env', body: pgEnv.join('\n') + '\n', ...ROOT, mode: 0o400, names: pgEnv.map((l) => l.slice(0, l.indexOf('='))) },
      // Copied to the VX1 by deploy.sh: hashes only, no token.
      { path: 'sandbox-manager/env', body: `SANDBOX_MANAGER_CALLERS=${callers['sandbox-manager']!.join(',')}\n`, ...ROOT, mode: 0o400, names: ['SANDBOX_MANAGER_CALLERS'] },
    );

    if (problems.length) {
      print(`prod-secrets: nothing written:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
      return 1;
    }

    // --- write: the state first (so a crash part-way keeps the same values next time), each file atomically
    const write = (rel: string, body: string, o: { uid: number; gid: number; mode: number }) => {
      const p = join(out, rel);
      const dir = join(p, '..');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, body, { mode: o.mode });
      chmodSync(tmp, o.mode);
      if (!dry) {
        chownSync(dir, 0, 0);
        chownSync(tmp, o.uid, o.gid);
      }
      renameSync(tmp, p);
    };
    mkdirSync(out, { recursive: true, mode: 0o700 });
    write('_state/values', [...state].map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { ...ROOT, mode: 0o600 });
    for (const f of files) write(f.path, f.body, f);

    // --- report: names, owners, modes and sizes only, checked against every value before it is printed
    const report = [
      `prod-secrets: ${dry ? 'DRY RUN, ' : ''}wrote ${files.length} files to ${tempOut ? '<a temp folder, removed below>' : out}${dry ? ' (no chown)' : ''}`,
      ...(placeholders.length ? [`  placeholders (dry run only): ${placeholders.join(', ')}`] : []),
      ...(rotate ? ['  --rotate: new tokens and passwords. Run db-init.sql again, then restart every service.'] : []),
      ...files.map((f) => {
        const what = f.names ? f.names.join(' ') : `${Buffer.byteLength(f.body)} bytes`;
        return `  ${f.mode.toString(8).padStart(4, '0')} ${`${f.uid}:${f.gid}`.padEnd(11)} ${f.path.padEnd(24)} ${what}${f.note ? `  [${f.note}]` : ''}`;
      }),
      `  valkey channels (users.acl): ${SERVICES.map((s) => {
        const rule = valkeyAclRule(s);
        const ch = [...rule.matchAll(/&(\S+)/g)].map((m) => m[1]).join(',');
        const how = [rule.includes('+publish') && 'pub', /\+p?subscribe/.test(rule) && 'sub'].filter(Boolean).join('+');
        return ch ? `${s} ${how} ${ch}` : '';
      }).filter(Boolean).join('; ')}`,
      `  sandbox-manager/env goes to the VX1 (deploy.sh). Fingerprint of runner's caller hash: ${createHash('sha256').update(callers['sandbox-manager']!.join(',')).digest('hex').slice(0, 12)}`,
    ].join('\n');
    const values = [...state.values(), sessionPem, auditPem, master, boardS3.body, auditS3.body, inference.body, brave.body]
      .flatMap((v) => [v, ...v.split('\n')])
      .map((v) => v.trim())
      .filter((v) => v.length >= 8 && !v.startsWith('-----'));
    // Also the S3 key pair's parts, one by one.
    for (const b of [boardS3.body, auditS3.body]) for (const m of b.matchAll(/=\s*(\S{8,})/g)) values.push(m[1]!);
    if (values.some((v) => report.includes(v))) {
      print('prod-secrets: the report would show a secret value, so it is not printed. This is a bug in prod-secrets.ts.\n');
      return 1;
    }
    print(report + '\n');
    return 0;
  } finally {
    if (tempOut) {
      rmSync(out, { recursive: true, force: true });
      print('prod-secrets: removed the dry run\'s temp folder\n');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2), process.env, (s) => process.stdout.write(s));
}
