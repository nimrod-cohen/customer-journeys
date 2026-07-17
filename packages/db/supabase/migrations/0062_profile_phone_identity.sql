-- 0062_profile_phone_identity.sql
-- Phone as a CORE identity field. A profile can be identified by email and/or phone;
-- each alone is optional, but at least one is required. Phones are stored normalized to
-- E.164 (done in app code). Mirrors the email identity model (UNIQUE(workspace_id, email)).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone text;

-- At most one profile per (workspace, phone); many NULL phones are allowed (a profile may
-- be email-only). Partial unique so NULLs don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_workspace_phone_key
  ON profiles (workspace_id, phone) WHERE phone IS NOT NULL;

-- A workspace-scoped lookup index (identity resolution by phone).
CREATE INDEX IF NOT EXISTS profiles_workspace_id_phone_idx ON profiles (workspace_id, phone);

-- At least one identifier must be present. Every existing row has an email, so this holds
-- immediately (email was the previous required key).
ALTER TABLE profiles
  ADD CONSTRAINT profiles_identity_present CHECK (email IS NOT NULL OR phone IS NOT NULL);
