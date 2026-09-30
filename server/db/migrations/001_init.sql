create extension if not exists pgcrypto;

create table if not exists users (
  id text primary key,
  name text not null,
  roles jsonb not null,
  token text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists devices (
  id text primary key,
  name text not null,
  source_kind text not null check (source_kind in ('temperature','ph')),
  ingest_token text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists domain_events (
  event_id uuid primary key,
  stream_type text not null check (stream_type in ('batch','culture','milk')),
  stream_id text not null,
  revision integer not null check (revision > 0),
  plan_version integer not null check (plan_version >= 0),
  payload jsonb not null,
  server_recorded_at timestamptz not null default now(),
  unique (stream_type, stream_id, revision)
);
create index if not exists domain_events_stream_idx on domain_events(stream_type, stream_id, revision);
create index if not exists domain_events_recorded_idx on domain_events(server_recorded_at);

create table if not exists measurement_sources (
  source_id text primary key references devices(id),
  batch_id text,
  note text
);

create table if not exists clock_anchors (
  anchor_id uuid primary key,
  source_id text not null references devices(id),
  seq integer not null check (seq > 0),
  device_time timestamptz not null,
  reference_time timestamptz not null,
  drift_ms bigint not null,
  received_at timestamptz not null default now(),
  unique (source_id, seq)
);

create table if not exists readings (
  reading_id uuid primary key,
  source_id text not null references devices(id),
  source_kind text not null check (source_kind in ('temperature','ph')),
  batch_id text not null,
  seq integer not null check (seq > 0),
  value numeric(8,3) not null,
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  calibration_anchor_id uuid references clock_anchors(anchor_id),
  unique (source_id, seq),
  check ((source_kind = 'ph' and value >= 0 and value <= 14) or (source_kind = 'temperature' and value >= -10 and value <= 130))
);
create index if not exists readings_batch_seq_idx on readings(batch_id, source_id, seq);
create index if not exists readings_received_idx on readings(received_at);

create table if not exists offline_tickets (
  ticket_id uuid primary key,
  user_id text not null references users(id),
  secret text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked boolean not null default false
);
create index if not exists offline_tickets_user_idx on offline_tickets(user_id);

insert into users(id,name,roles,token) values
 ('u_operator','艾操作员','["operator"]'::jsonb,'demo-operator'),
 ('u_quality','柏质量','["quality"]'::jsonb,'demo-quality'),
 ('u_supervisor','管主管','["supervisor"]'::jsonb,'demo-supervisor')
on conflict do nothing;

insert into devices(id,name,source_kind,ingest_token) values
 ('temp-001','1号温度探头','temperature','ingest-temp-001'),
 ('ph-001','1号pH计','ph','ingest-ph-001')
on conflict do nothing;

insert into measurement_sources(source_id, note) values
 ('temp-001','演示温度来源'),('ph-001','演示pH来源')
on conflict do nothing;
