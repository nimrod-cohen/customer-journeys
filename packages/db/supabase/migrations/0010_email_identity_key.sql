-- 0010_email_identity_key.sql
-- Identity re-key (§6/§7): events arrive from MANY source systems, and the only
-- identifier that connects a person's events together is their EMAIL. So email
-- becomes the per-workspace identity/merge key for profiles, and external_id is
-- demoted to optional metadata (no longer unique, no longer required).
--
--   - Drop the old per-workspace uniqueness on external_id.
--   - Add per-workspace uniqueness on email. NULLs are distinct in a unique index
--     (Postgres), so legacy/stub rows without an email are allowed; non-null
--     emails are unique per workspace — the key ingestion/manual-create upsert on.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_workspace_id_external_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_workspace_email_key
  ON profiles (workspace_id, email);
