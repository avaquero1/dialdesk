-- board: boards, widgets (spec and profile), the layout and folders, results with their run trace (current and
-- previous, for "since you last looked"), pending proposals, the runs board enqueued, and screenshot keys.
-- Runs inside schema "board" as role svc_board. Every row carries account_id, and every query filters on it.

create table boards (
  account_id text primary key check (account_id ~ '^acc_[A-Za-z0-9]{8,32}$'),
  category   text not null check (category in ('sports')),
  created_at timestamptz not null default now()
);

-- spec: the catalog-validated spec without its place (in layout) and a folder's children (derived from layout).
-- profile: the sub-agent's memory, displays only. The user's words, source ids and settings; never page text.
-- quotes: first paint, cached market prices from markets until the first result lands.
create table widgets (
  widget_id  text primary key check (widget_id ~ '^wid_[A-Za-z0-9]{8,32}$'),
  account_id text not null references boards (account_id) on delete cascade,
  seq        bigint generated always as identity,
  kind       text not null check (kind in ('app', 'display', 'folder')),
  spec       jsonb not null,
  profile    jsonb,
  state      text not null check (state in ('normal', 'refreshing', 'blocked', 'new')),
  quotes     jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'display') = (profile is not null)),
  check (spec ->> 'widget_id' = widget_id and spec ->> 'account_id' = account_id and spec ->> 'kind' = kind),
  unique (widget_id, account_id)
);
create index widgets_account on widgets (account_id, seq);

-- Where each tile sits: a grid cell, or a slot inside a folder of the same account. A folder can't be deleted while
-- tiles are in it (board moves them back to the grid first; a whole board still cascades).
create table layout (
  widget_id  text primary key,
  account_id text not null,
  col        int check (col between 0 and 63),
  "row"      int check ("row" between 0 and 255),
  folder_id  text,
  idx        int check (idx between 0 and 63),
  foreign key (widget_id, account_id) references widgets (widget_id, account_id) on delete cascade,
  foreign key (folder_id, account_id) references widgets (widget_id, account_id),
  check ((col is not null and "row" is not null and folder_id is null and idx is null)
      or (col is null and "row" is null and folder_id is not null and idx is not null)),
  check (folder_id is distinct from widget_id)
);
create index layout_folder on layout (folder_id) where folder_id is not null;

-- Two slots per widget: the current result and the previous run's. A second phase of the same run (the summary)
-- replaces the current slot. Nothing gets in without its passing publish verdict.
create table results (
  widget_id  text not null,
  account_id text not null,
  slot       text not null check (slot in ('current', 'previous')),
  result_id  text not null,
  run_id     text not null,
  kind       text not null check (kind in ('numbers', 'research')),
  phase      text not null check (phase in ('numbers', 'summary')),
  result     jsonb not null,
  verdict    jsonb not null,
  trace      jsonb not null,
  stored_at  timestamptz not null default now(),
  primary key (widget_id, slot),
  foreign key (widget_id, account_id) references widgets (widget_id, account_id) on delete cascade,
  check (verdict ->> 'stage' = 'publish' and verdict ->> 'outcome' = 'pass'
     and verdict ->> 'verdict_id' = result ->> 'verdict_id' and result ->> 'result_id' = result_id
     and result ->> 'widget_id' = widget_id and result ->> 'run_id' = run_id)
);
create index results_account on results (account_id);
create index results_receipts on results using gin ((result -> 'receipts') jsonb_path_ops);

-- The agent proposes; only the user's click (accept) makes the changes real.
create table proposals (
  proposal_id text primary key check (proposal_id ~ '^prp_[A-Za-z0-9]{8,32}$'),
  account_id  text not null references boards (account_id) on delete cascade,
  status      text not null check (status in ('pending', 'accepted', 'rejected')),
  changes     jsonb not null check (jsonb_typeof(changes) = 'array' and jsonb_array_length(changes) between 1 and 6),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  check ((status = 'pending') = (decided_at is null))
);
create index proposals_pending on proposals (account_id, created_at) where status = 'pending';

-- Every run board put on widget-runs. The job id (widget + kind + minute window) collapses duplicates, and
-- "Refresh now" is rate limited from here.
create table run_requests (
  job_id       text primary key,
  widget_id    text not null,
  account_id   text not null,
  kind         text not null check (kind in ('numbers', 'research')),
  reason       text not null check (reason in ('accept', 'schedule', 'refresh', 'movement', 'clear')),
  window_start bigint not null,
  requested_at timestamptz not null default now(),
  foreign key (widget_id, account_id) references widgets (widget_id, account_id) on delete cascade
);
create index run_requests_widget on run_requests (widget_id, requested_at);

-- Screenshot keys in Object Storage (the bytes live there, not here). Hash and size for the audit log.
create table screenshots (
  screenshot_key text primary key,
  widget_id      text not null,
  account_id     text not null,
  run_id         text not null,
  candidate_id   text not null,
  bytes          int not null check (bytes > 0),
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  stored_at      timestamptz not null default now(),
  foreign key (widget_id, account_id) references widgets (widget_id, account_id) on delete cascade
);
