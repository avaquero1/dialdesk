-- One board's numbers widgets, computed in one compute box per tick (A1.4.1). The scheduler saves the batch under the
-- first widget's job id; the job reads it back. Rows older than a day are deleted when a new one is saved.
create table batches (
  job_id     text primary key,
  account_id text not null check (account_id ~ '^acc_[A-Za-z0-9]{8,32}$'),
  widget_ids jsonb not null check (jsonb_typeof(widget_ids) = 'array'),
  created_at timestamptz not null default now()
);
create index batches_created on batches (created_at);
