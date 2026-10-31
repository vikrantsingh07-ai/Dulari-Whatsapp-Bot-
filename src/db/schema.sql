-- Dulari WhatsApp agent schema. Idempotent: safe to run on every boot.
create extension if not exists pgcrypto;

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null unique,
  name text,
  language text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  opted_out boolean not null default false,
  followup_consent boolean not null default false,
  muted boolean not null default false
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null unique references contacts(id) on delete cascade,
  bot_mode text not null default 'auto' check (bot_mode in ('auto','human','shadow','off')),
  mode_changed_by text,
  mode_changed_at timestamptz not null default now(),
  owner text,
  last_inbound_at timestamptz,
  last_human_at timestamptz,
  window_expires_at timestamptz,
  reply_due_at timestamptz,
  reply_job_id text,
  reply_first_at timestamptz,
  pending_plan jsonb,
  greeted_at timestamptz,
  abuse_count int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  wa_message_id text not null unique,
  direction text not null check (direction in ('in','out','echo')),
  author text not null check (author in ('customer','bot','human')),
  type text not null default 'text',
  text text,
  media_id text,
  mime_type text,
  filename text,
  transcript text,
  quoted_id text,
  referral jsonb,
  status text,
  error_code text,
  retries int not null default 0,
  synced boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_conv_idx on messages (conversation_id, id desc);

create table if not exists leads (
  contact_id uuid primary key references contacts(id) on delete cascade,
  type text,
  firm text,
  city text,
  products text[] not null default '{}',
  project_type text,
  quantity text,
  timeline text,
  budget text,
  source text,
  status text not null default 'new',
  hot boolean not null default false,
  owner text,
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists handoffs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  reason text not null,
  urgency text not null default 'normal',
  summary text,
  created_at timestamptz not null default now(),
  claimed_by text,
  claimed_at timestamptz,
  due_at timestamptz,
  last_alert_at timestamptz,
  alert_count int not null default 1,
  holding_sent_at timestamptz,
  snoozed_until timestamptz,
  resolved_at timestamptz
);
create index if not exists handoffs_open_idx on handoffs (conversation_id) where resolved_at is null;

create table if not exists followups (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  template text not null,
  due_at timestamptz not null,
  sent_at timestamptz,
  cancelled_reason text
);
create index if not exists followups_pending_idx on followups (conversation_id) where sent_at is null and cancelled_reason is null;

create table if not exists llm_calls (
  id bigserial primary key,
  conversation_id uuid references conversations(id) on delete set null,
  purpose text,
  model text not null,
  input_tokens int,
  output_tokens int,
  cache_read_tokens int,
  cache_write_tokens int,
  cost numeric,
  latency_ms int,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists media (
  media_id text primary key,
  mime_type text,
  data bytea not null,
  created_at timestamptz not null default now()
);

create table if not exists alerts (
  chat_id text not null,
  message_id bigint not null,
  conversation_id uuid not null references conversations(id) on delete cascade,
  handoff_id uuid,
  draft_id uuid,
  primary key (chat_id, message_id)
);

create table if not exists drafts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  bubbles jsonb not null,
  customer_text text,
  rating text check (rating in ('up','down')),
  created_at timestamptz not null default now()
);

create table if not exists brain_snapshots (
  id serial primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
