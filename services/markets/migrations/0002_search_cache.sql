-- markets: Brave Search results per market, shared by every follower and kept across restarts.
-- Only links, domains and dates: never titles, snippets or page text.
create table if not exists search_cache (
  shared_key text primary key,
  query text not null,
  hits jsonb not null,
  cached_at timestamptz not null
);
