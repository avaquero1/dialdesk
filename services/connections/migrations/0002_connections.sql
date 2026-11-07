-- connections: the vault. Private keys are stored only as AES-256-GCM blobs (src/vault.ts) under a key derived from the
-- master key file, which lives outside the database. A database dump alone opens nothing.
create table connections (
  connection_id  text primary key,
  account_id     text not null,
  exchange       text not null check (exchange in ('kalshi', 'polymarket')),
  label          text not null,
  env            text check (env in ('prod', 'demo')),
  key_id         text,
  key_type       text check (key_type in ('ed25519', 'rsa')),
  key_blob       bytea,
  key_fingerprint text,
  wallet         text,
  scopes         text[] not null default '{}',
  scope_verified boolean not null,
  checked_at     timestamptz,
  share_numbers  boolean not null default false,
  public_data    boolean not null,
  created_at     timestamptz not null default now(),
  check ((exchange = 'kalshi') = (key_blob is not null and key_id is not null and env is not null)),
  check ((exchange = 'polymarket') = (wallet is not null))
);
create index connections_account on connections (account_id);

-- The last numbers read for a connection (balance and positions only), replaced on each account-refresh job.
create table numbers (
  connection_id text primary key references connections (connection_id) on delete cascade,
  balance_cents bigint,
  positions     jsonb not null,
  as_of         timestamptz not null
);
