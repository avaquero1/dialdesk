-- models: metered Vultr Inference usage, one row per UTC day, account, role and model. Counts and cost only: never a prompt.
create table usage (
  day date not null,
  account text not null, -- an account id, or 'system' for calls with no account
  role text not null check (role in ('chat', 'planner', 'reader', 'summarizer', 'guard')),
  model text not null,
  calls integer not null default 0 check (calls >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cost_usd numeric(14, 8) not null default 0 check (cost_usd >= 0),
  primary key (day, account, role, model)
);
create index usage_day on usage (day);
