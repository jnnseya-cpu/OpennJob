-- OpennJob - migration 003: notifications (in-app inbox, delivery log, preferences).
--
-- Everything is per account and goes with it (ON DELETE CASCADE). A delivery row records
-- which event went to which channel and what happened; it keeps no message text and no
-- address. Notification subjects and bodies name at most a job title, an employer and counts.

CREATE TABLE notifications (
  seq         BIGSERIAL,
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key   TEXT NOT NULL,
  category    TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('info', 'success', 'warning', 'critical')),
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  read_at     TIMESTAMPTZ
);
CREATE INDEX notifications_user_idx ON notifications (user_id, seq);

CREATE TABLE notification_deliveries (
  seq         BIGSERIAL,
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key   TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'inapp', 'sms', 'push', 'whatsapp')),
  status      TEXT NOT NULL CHECK (status IN ('delivered', 'sent', 'logged', 'skipped', 'failed')),
  provider    TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX notification_deliveries_user_idx ON notification_deliveries (user_id, seq);

CREATE TABLE notification_preferences (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
