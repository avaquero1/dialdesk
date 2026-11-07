-- accounts: the accounts and their sessions. Runs in schema "accounts" as role svc_accounts.
-- Passwords are argon2id PHC strings (never plain text). A guest has no email and no password.
create table accounts (
  account_id    text primary key check (account_id ~ '^acc_[A-Za-z0-9]{8,32}$'),
  email         text unique check (email = lower(email) and length(email) <= 254),
  password_hash text check (password_hash like '$argon2id$%'),
  plan          text not null default 'free' check (plan in ('free', 'pro')),
  guest         boolean not null,
  -- {theme, mode, hue}: validated against the Look schema before every write (and again on read).
  look          jsonb not null check (jsonb_typeof(look) = 'object' and look ?& array['theme', 'mode', 'hue']),
  created_at    timestamptz not null default now(),
  check ((guest and email is null and password_hash is null) or (not guest and email is not null and password_hash is not null))
);
create index accounts_guest_created on accounts (created_at) where guest;

-- One row per session: the JWT carries the id, edge asks whether it's still valid (logout revokes it).
create table sessions (
  session_id text primary key check (session_id ~ '^ses_[A-Za-z0-9]{8,32}$'),
  account_id text not null references accounts (account_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_account on sessions (account_id);
