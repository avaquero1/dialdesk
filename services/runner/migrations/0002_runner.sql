-- runner: run_state (one row per run, resumed from the last completed step) and the schedule (the cadence runs).
-- Runs inside schema "runner" as role svc_runner. outputs holds each finished step's output for resume: candidate
-- ids, the plan, facts the guard passed, engine numbers. Never raw page text.

create table run_state (
  run_id      text primary key check (run_id ~ '^run_[A-Za-z0-9]{8,32}$'),
  job_id      text not null unique,
  widget_id   text not null check (widget_id ~ '^wid_[A-Za-z0-9]{8,32}$'),
  account_id  text not null check (account_id ~ '^acc_[A-Za-z0-9]{8,32}$'),
  kind        text not null check (kind in ('numbers', 'research')),
  status      text not null check (status in ('running', 'done', 'poisoned', 'failed')),
  last_step   text,
  steps       jsonb not null default '[]',
  outputs     jsonb not null default '{}',
  attempt     integer not null default 1,
  started_at  timestamptz not null,
  finished_at timestamptz
);
create index run_state_widget on run_state (widget_id, started_at desc);

-- One row per widget and kind with a cadence. active_at: the last run a user started (accept, refresh, clear);
-- research runs only while that is under a day old.
create table schedule (
  widget_id   text not null check (widget_id ~ '^wid_[A-Za-z0-9]{8,32}$'),
  kind        text not null check (kind in ('numbers', 'research')),
  account_id  text not null check (account_id ~ '^acc_[A-Za-z0-9]{8,32}$'),
  every_s     integer not null check (every_s >= 60),
  next_at     timestamptz not null,
  active_at   timestamptz not null,
  primary key (widget_id, kind)
);
create index schedule_due on schedule (next_at);
