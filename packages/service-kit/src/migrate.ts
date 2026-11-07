import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import type { Logger } from './log.ts';

/**
 * The migration hook. Applies services/<name>/migrations/NNNN_*.sql in order, once each, inside the service's own
 * schema (its role's search_path), and records them in `<schema>._migrations`. Runs at start in real mode.
 */
export async function migrate(opts: { databaseUrl: string; schema: string; dir: string; log: Logger }): Promise<string[]> {
  if (!existsSync(opts.dir)) return [];
  const files = readdirSync(opts.dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const sql = postgres(opts.databaseUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
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
