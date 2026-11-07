-- audit: the hash-chained log, its signed heads and their pushes to write-once storage. Append-only.
-- Runs inside schema "audit" as role svc_audit, the tables' owner.
--
-- Two locks on every table, so a bug or a stolen svc_audit login can't rewrite history quietly:
--   1. REVOKE UPDATE, DELETE, TRUNCATE from the owner itself (and from PUBLIC): Postgres answers "permission denied".
--   2. A trigger that rejects UPDATE, DELETE and TRUNCATE for anyone, a superuser included, unless they disable it.
-- The owner could still grant itself the rights back or drop the trigger. The signed heads in write-once storage
-- are what catch that: GET /audit/verify checks the rows against every pushed head.
-- No foreign keys: their check locks the parent row (FOR KEY SHARE), which needs the UPDATE right revoked below.

create table chain (
  seq bigint primary key check (seq >= 0),
  row_id text not null unique check (row_id ~ '^aud_[A-Za-z0-9]{8,32}$'),
  stream_id text unique,
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  entry jsonb not null,
  recorded_at timestamptz not null default now()
);
create index chain_account_action on chain ((entry->>'account_id'), (entry->>'action'));

create table heads (
  seq bigint primary key,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  signed_at timestamptz not null,
  signed_at_text text not null,
  key_id text not null,
  signature text not null
);

create table head_pushes (
  seq bigint primary key,
  object_key text not null,
  store text not null,
  pushed_at timestamptz not null default now()
);

create function reject_change() returns trigger language plpgsql as $$
begin
  raise exception 'audit: % on %.% is refused: the audit log is append-only', tg_op, tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end $$;

create trigger chain_append_only before update or delete on chain for each row execute function reject_change();
create trigger chain_no_truncate before truncate on chain for each statement execute function reject_change();
create trigger heads_append_only before update or delete on heads for each row execute function reject_change();
create trigger heads_no_truncate before truncate on heads for each statement execute function reject_change();
create trigger head_pushes_append_only before update or delete on head_pushes for each row execute function reject_change();
create trigger head_pushes_no_truncate before truncate on head_pushes for each statement execute function reject_change();

revoke update, delete, truncate on chain, heads, head_pushes from public;
revoke update, delete, truncate on chain, heads, head_pushes from current_user;
