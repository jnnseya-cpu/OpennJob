-- OpennJob - migration 002: accounts, consent, and columns that hold encrypted values.
--
-- Nothing wrote to these tables before this migration (v1 ran on the in-memory store), so
-- the NOT NULL columns added to `users` need no backfill.

-- ---- Accounts and consent ---------------------------------------------------------
ALTER TABLE users
  ALTER COLUMN email SET NOT NULL,
  ADD COLUMN password_hash            TEXT NOT NULL,          -- bcrypt; never the password
  ADD COLUMN accepted_terms_version   TEXT NOT NULL,
  ADD COLUMN accepted_privacy_version TEXT NOT NULL,
  ADD COLUMN consent_at               TIMESTAMPTZ NOT NULL,   -- when the two versions were accepted
  ADD CONSTRAINT users_email_lower CHECK (email = lower(email));

-- ---- Passport: one value, encrypted by the API ------------------------------------
-- The passport (registration numbers, memberships, clearance, DBS, right-to-work
-- confirmation, training, referees) is stored as a single value. With OPENNJOB_DATA_KEY
-- set it is AES-256-GCM ciphertext ("enc:v1:..."); without it, the JSON text. Either way
-- the database cannot be queried by passport content, which is intended.
DROP TABLE passports;
CREATE TABLE passports (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- profiles.cv_text and applications.statement are TEXT already. They hold ciphertext
-- ("enc:v1:...") when OPENNJOB_DATA_KEY is set. No column change is needed for that.

-- ---- Columns that must round-trip exactly what the API stored -----------------------
-- "No preferences" (NULL) is not the same as "empty preferences".
ALTER TABLE profiles
  ALTER COLUMN preferences DROP NOT NULL,
  ALTER COLUMN preferences DROP DEFAULT;

-- A job source's posting date is kept as the text the source gave. An absent language
-- still means 'en' and an absent origin still means 'discovered' (see the Job type).
ALTER TABLE jobs
  ALTER COLUMN posted_at TYPE TEXT USING posted_at::text,
  ALTER COLUMN language DROP NOT NULL,
  ALTER COLUMN language DROP DEFAULT,
  ALTER COLUMN origin DROP NOT NULL,
  ALTER COLUMN origin DROP DEFAULT,
  ALTER COLUMN salary_min TYPE DOUBLE PRECISION,
  ALTER COLUMN salary_max TYPE DOUBLE PRECISION;
-- The API can hold a job that both "requires registration" (read from the advert) and names
-- another required credential (given by the source). The database must accept what the API accepts.
ALTER TABLE jobs DROP CONSTRAINT jobs_check;
ALTER TABLE jobs DROP CONSTRAINT jobs_check1;
ALTER TABLE jobs ADD CONSTRAINT jobs_origin_matches_source
  CHECK ((coalesce(origin, 'discovered') = 'employer') = (source = 'employer'));

-- ---- Events that belong to no account ---------------------------------------------
-- An employer's posting and an account deletion are logged without a user (NULL). Events
-- of an account are deleted with it (ON DELETE CASCADE, from migration 001).
ALTER TABLE events ALTER COLUMN user_id DROP NOT NULL;

-- ---- Insertion order --------------------------------------------------------------
-- Rows written in the same millisecond still come back in the order they were written.
ALTER TABLE events ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE applications ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;

ALTER TABLE usage_records ALTER COLUMN acu TYPE DOUBLE PRECISION;
