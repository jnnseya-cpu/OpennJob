-- "Keep me signed in": a long-lived refresh token, stored only as its SHA-256, used once and
-- replaced on every use, revoked on sign-out and on a password reset.
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_kind_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_kind_check CHECK (kind IN ('verify-email', 'reset-password', 'refresh'));
