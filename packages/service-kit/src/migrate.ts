import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import type { Logger } from './log.ts';

function migrationFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

/**
 * The migration hook. Applies services/<name>/migrations/NNNN_*.sql in order, once each, inside the service's own
 * schema (its role's search_path), and records them in `<schema>._migrations`. Runs at start in real mode.
 *
 * `role`: run them as this role (SET ROLE after login) instead of the login itself. audit's tables belong to the
 * NOLOGIN role audit_owner, so an admin login that may SET ROLE audit_owner applies them (see deploy/db-init.sql).
 */
export async function migrate(opts: { databaseUrl: string; schema: string; dir: string; log: Logger; role?: string }): Promise<string[]> {
  const files = migrationFiles(opts.dir);
  if (files.length === 0) return [];
  const sql = postgres(opts.databaseUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    if (opts.role) await sql`set role ${sql(opts.role)}`;
    await sql`set search_path to ${sql(opts.schema)}`;
    await sql`create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await sql<{ name: string }[]>`select name from _migrations`).map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const text = readFileSync(join(opts.dir, f), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into _migrations (name) values (${f})`;
      });
      applied.push(f);
      opts.log.info({ migration: f }, 'migration applied');
    }
  } finally {
    await sql.end();
  }
  return applied;
}

/** The migrations in `dir` not yet applied in `schema` (all of them when `_migrations` doesn't exist). Reads only. */
export async function pendingMigrations(opts: { databaseUrl: string; schema: string; dir: string }): Promise<string[]> {
  const files = migrationFiles(opts.dir);
  if (files.length === 0) return [];
  const sql = postgres(opts.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const [t] = await sql<{ t: string | null }[]>`select to_regclass(${opts.schema + '._migrations'})::text as t`;
    if (!t?.t) return files;
    const done = new Set((await sql<{ name: string }[]>`select name from ${sql(opts.schema)}._migrations`).map((r) => r.name));
    return files.filter((f) => !done.has(f));
  } finally {
    await sql.end();
  }
}
