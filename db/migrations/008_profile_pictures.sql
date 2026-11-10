-- A person's own profile photo and cover image, as small data: URLs.
-- Personal data: stored encrypted (AES-256-GCM, like cv_text), nullable, absent by default.
ALTER TABLE profiles ADD COLUMN avatar text;
ALTER TABLE profiles ADD COLUMN cover text;
