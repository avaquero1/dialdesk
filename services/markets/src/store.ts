import postgres from 'postgres';
import type { SearchHit } from './brave.ts';

/**
 * Where a search's result outlives the process: one row per shared key (`brave:<event key>`), so a restart doesn't spend
 * the Brave quota again. Only links, domains and dates are stored, never titles or page text.
 */
export interface SearchRecord {
  query: string;
  hits: SearchHit[];
  cached_at: string;
}

export interface SearchStore {
  get(sharedKey: string): Promise<SearchRecord | null>;
  put(sharedKey: string, rec: SearchRecord): Promise<void>;
  close?(): Promise<void>;
}

export function memoryStore(): SearchStore {
  const m = new Map<string, SearchRecord>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, r) => void m.set(k, r),
  };
}

export function postgresStore(databaseUrl: string): SearchStore {
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {}, connection: { search_path: 'markets' } });
  return {
    async get(k) {
      const rows = await sql<{ query: string; hits: SearchHit[]; cached_at: Date }[]>`
        select query, hits, cached_at from search_cache where shared_key = ${k}`;
      const r = rows[0];
      return r ? { query: r.query, hits: r.hits, cached_at: r.cached_at.toISOString() } : null;
    },
    async put(k, r) {
      await sql`
        insert into search_cache (shared_key, query, hits, cached_at)
        values (${k}, ${r.query}, ${sql.json(r.hits as never)}, ${r.cached_at})
        on conflict (shared_key) do update set query = excluded.query, hits = excluded.hits, cached_at = excluded.cached_at`;
    },
    close: () => sql.end(),
  };
}
