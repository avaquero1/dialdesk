-- agent: conversation history. Runs inside schema "agent" as role svc_agent.
-- A turn keeps what the user saw (text, chips) and, for agent turns, the model's template with its slots unfilled:
-- the history sent back to the model is the template, so the model never reads a number it didn't get from a tool.

create table conversations (
  conversation_id text primary key,
  account_id      text not null,
  widget_id       text,
  created_at      timestamptz not null default now()
);
create index conversations_account on conversations (account_id);

create table turns (
  seq             bigint generated always as identity primary key,
  turn_id         text not null unique,
  conversation_id text not null references conversations (conversation_id) on delete cascade,
  role            text not null check (role in ('user', 'agent')),
  text            text not null,
  template        text,
  chips           jsonb not null default '[]',
  verdict_id      text,
  at              timestamptz not null
);
create index turns_conversation on turns (conversation_id, seq);
