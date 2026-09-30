CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operator','supervisor','quality','admin')),
  can_inoculate BOOLEAN NOT NULL DEFAULT false,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('temperature','ph')),
  tank_id TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calibration_anchors (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  anchored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_clock_at TIMESTAMPTZ NOT NULL,
  clock_offset_ms BIGINT NOT NULL,
  recorded_by TEXT REFERENCES users(id),
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS milk_bases (
  id TEXT PRIMARY KEY,
  batch_ref TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','verified','consumed','rejected')),
  volume_liters NUMERIC(10,2) NOT NULL CHECK (volume_liters > 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strain_versions (
  id TEXT PRIMARY KEY,
  strain_code TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged','released','quarantined','consumed')),
  lot TEXT NOT NULL,
  released_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (strain_code, version)
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  tank_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  culture_version_id TEXT REFERENCES strain_versions(id),
  milk_base_id TEXT REFERENCES milk_bases(id),
  culture_state TEXT NOT NULL DEFAULT 'staged' CHECK (culture_state IN ('staged','released','quarantined','consumed')),
  milk_state TEXT NOT NULL DEFAULT 'prepared' CHECK (milk_state IN ('prepared','verified','consumed','rejected')),
  inoculation_state TEXT NOT NULL DEFAULT 'not_started' CHECK (inoculation_state IN ('not_started','awaiting_signatures','issued','cancelled')),
  cooling_state TEXT NOT NULL DEFAULT 'warm' CHECK (cooling_state IN ('warm','cooling','cooled')),
  filling_state TEXT NOT NULL DEFAULT 'not_filled' CHECK (filling_state IN ('not_filled','filling','filled')),
  phase TEXT NOT NULL DEFAULT 'draft' CHECK (phase IN ('draft','ready','inoculated','cooling','cooled','filling','filled','reconcile_required','completed')),
  inoculated_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batches_tank ON batches(tank_id);

CREATE TABLE IF NOT EXISTS batch_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  version INTEGER NOT NULL,
  culture_version_id TEXT REFERENCES strain_versions(id),
  milk_base_id TEXT REFERENCES milk_bases(id),
  changed_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, version)
);

CREATE TABLE IF NOT EXISTS events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  batch_id TEXT REFERENCES batches(id),
  source_id TEXT,
  source_seq INTEGER,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  author_id TEXT REFERENCES users(id),
  author_role TEXT,
  collected_at TIMESTAMPTZ,
  corrected_collected_at TIMESTAMPTZ,
  client_created_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  calibration_anchor_id BIGINT REFERENCES calibration_anchors(id),
  clock_offset_ms BIGINT NOT NULL DEFAULT 0,
  raw_hash TEXT,
  auth_scope TEXT NOT NULL DEFAULT 'offline_fact' CHECK (auth_scope IN ('offline_fact','online_authorized')),
  accepted BOOLEAN NOT NULL DEFAULT true,
  out_of_order BOOLEAN NOT NULL DEFAULT false,
  replaced_by_event_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_source_seq ON events(batch_id, source_id, source_seq) WHERE source_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_batch_time ON events(batch_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS inoculation_confirmations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  batch_version INTEGER NOT NULL,
  culture_version_id TEXT NOT NULL REFERENCES strain_versions(id),
  signer_id TEXT NOT NULL REFERENCES users(id),
  evidence_watermark BIGINT,
  evidence_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  declared_inoculated_at TIMESTAMPTZ,
  authorized_at TIMESTAMPTZ,
  result TEXT NOT NULL CHECK (result IN ('pending','issued','rejected')),
  reject_reason TEXT,
  client_created_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, batch_version, culture_version_id, signer_id)
);
CREATE INDEX IF NOT EXISTS idx_confirmations_lookup ON inoculation_confirmations(batch_id, batch_version, culture_version_id, result);

CREATE TABLE IF NOT EXISTS source_watermarks (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  accepted_watermark INTEGER NOT NULL DEFAULT 0,
  last_event_id BIGINT REFERENCES events(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, source_id)
);

CREATE TABLE IF NOT EXISTS coordination_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('offline_conflict','sequence_conflict','evidence_gap','qualification','duplicate_mismatch')),
  batch_id TEXT REFERENCES batches(id),
  source_id TEXT,
  reason TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_coordination_status ON coordination_items(status, batch_id);

CREATE TABLE IF NOT EXISTS authorization_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  batch_id TEXT,
  allowed BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
