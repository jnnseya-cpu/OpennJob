-- OpennJob - migration 004: applying on the candidate's behalf.
--
-- Statuses for held, uncertain, interview and closed applications; the duplicate key; the
-- tailored CV, the exact documents sent and the receipt (one encrypted value per application);
-- e-mail verification and password reset tokens (hashes only); ordinary screening answers
-- (encrypted); standing authorisation; job contract type; platform settings, one-off claims
-- and a shared rate-limit window.

ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

ALTER TABLE jobs ADD COLUMN contract_type TEXT CHECK (contract_type IN ('permanent', 'contract'));

ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check
  CHECK (status IN ('draft', 'confirmed', 'needs_you', 'submitted', 'uncertain', 'interview', 'closed'));
ALTER TABLE applications
  ADD COLUMN hold_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN dedupe_key   TEXT,
  ADD COLUMN automatic    BOOLEAN NOT NULL DEFAULT false,
  -- tailored CV, trace failures, sent documents and receipt: one value, encrypted by the API
  ADD COLUMN private_data TEXT;
CREATE INDEX applications_dedupe_idx ON applications (user_id, dedupe_key);

CREATE TABLE auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('verify-email', 'reset-password')),
  token_hash  TEXT NOT NULL UNIQUE,   -- SHA-256 of the token; the token itself is never stored
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE TABLE screening_answers (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,          -- encrypted by the API
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standing_authorisations (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform_claims (
  key         TEXT PRIMARY KEY,
  claimed_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE rate_limit_windows (
  key           TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  hits          INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
