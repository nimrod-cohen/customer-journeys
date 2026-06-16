-- 0031_user_credentials.sql
-- Local credential store for self-service company-owner REGISTRATION. In
-- production identity lives in Supabase Auth (see 0025); the local dev/e2e shim
-- needs somewhere to keep an email + password so a newly-registered owner can
-- log back in. Email is unique (citext → case-insensitive); password_hash is a
-- scrypt envelope ("scrypt$<saltHex>$<hashHex>"), never plaintext.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email         citext;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email) WHERE email IS NOT NULL;
