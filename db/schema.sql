-- OpennJob v1 - PostgreSQL schema
--
-- STATUS: this schema mirrors the Repository interface in packages/core/src/repository.ts.
-- The application does NOT use it yet: v1 runs on the in-memory repository. A
-- PostgresRepository that implements the interface against these tables is a next step.
--
-- Personal data: profiles.cv_text, every column of passports, and applications.statement
-- are personal data under UK GDPR. Before real users: encrypt at rest (at minimum the
-- passports table), restrict access, and set retention/deletion rules (see README).

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT NOT NULL,
  address_line1  TEXT NOT NULL,
  address_line2  TEXT,
  city           TEXT NOT NULL,
  postcode       TEXT NOT NULL,
  cv_text        TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The credential passport. Sensitive: registration, DBS, right-to-work confirmation, referees.
CREATE TABLE IF NOT EXISTS passports (
  user_id                  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nmc_pin                  TEXT,
  dbs_certificate_number   TEXT,
  dbs_issue_date           DATE,
  dbs_on_update_service    BOOLEAN,
  right_to_work_confirmed  BOOLEAN NOT NULL DEFAULT FALSE,
  -- [{ "name": "...", "completedOn": "YYYY-MM-DD", "expiresOn": "YYYY-MM-DD" }]
  training                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{ "name", "relationship", "organisation", "email", "phone" }]  (third parties' personal data)
  referees                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id                     TEXT PRIMARY KEY,            -- "<source>:<external_id>"
  source                 TEXT NOT NULL CHECK (source IN ('greenhouse', 'lever', 'ashby', 'adzuna', 'reed', 'sample')),
  external_id            TEXT NOT NULL,
  title                  TEXT NOT NULL,
  employer               TEXT NOT NULL,
  location               TEXT NOT NULL,
  url                    TEXT NOT NULL,
  apply_url              TEXT,
  description            TEXT NOT NULL,
  salary_min             NUMERIC(12, 2),
  salary_max             NUMERIC(12, 2),
  employment_type        TEXT,
  posted_at              TIMESTAMPTZ,
  -- [{ "label": "...", "essential": true, "keywords": ["..."] }]
  criteria               JSONB NOT NULL DEFAULT '[]'::jsonb,
  criteria_source        TEXT NOT NULL CHECK (criteria_source IN ('llm', 'fallback', 'provided')),
  requires_registration  BOOLEAN NOT NULL DEFAULT FALSE,
  -- normalised title|employer|location, used for cross-source de-duplication
  dedupe_key             TEXT NOT NULL,
  fetched_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS jobs_dedupe_key_idx ON jobs (dedupe_key);

CREATE TABLE IF NOT EXISTS applications (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  job_title         TEXT NOT NULL,
  employer          TEXT NOT NULL,
  apply_url         TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('review', 'hybrid', 'auto')),
  status            TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'submitted')),
  statement         TEXT NOT NULL,
  statement_source  TEXT NOT NULL CHECK (statement_source IN ('llm', 'fallback')),
  gaps              JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings          JSONB NOT NULL DEFAULT '[]'::jsonb,
  score             SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  -- names of the fields the user explicitly confirmed (audit trail; never the values)
  confirmed_fields  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL,
  confirmed_at      TIMESTAMPTZ,
  submitted_at      TIMESTAMPTZ,
  CHECK (status <> 'submitted' OR submitted_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS applications_user_idx ON applications (user_id, created_at DESC);

-- Append-only domain event log. Payloads hold ids and counters only, never personal data.
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurred_at  TIMESTAMPTZ NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_user_idx ON events (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type, occurred_at);

-- ACU (AI compute unit) usage, one row per LLM call. Mirrors the UsageMeter interface.
CREATE TABLE IF NOT EXISTS usage_records (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose        TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens  INTEGER NOT NULL CHECK (output_tokens >= 0),
  acu            NUMERIC(12, 3) NOT NULL CHECK (acu >= 0),
  at             TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_records_user_idx ON usage_records (user_id, at);

COMMIT;
