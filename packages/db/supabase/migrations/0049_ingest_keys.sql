-- 0049_ingest_keys.sql
-- Public, client-side "write keys" for the tracking/ingest API (identify + track),
-- the way Segment/Mixpanel work: a key embedded in front-end JS that can ONLY
-- create/update profiles and record events for its own workspace — never read,
-- update, or delete anything. No login, no username/password exposed.
--
-- Unlike workspace_api_keys (built for the AWS API-Gateway model, api_key_id from
-- the request context), these are self-contained: the raw key is sent by the
-- client, sha256-hashed, and looked up here to resolve the workspace. The key is
-- PUBLIC by design (it lives in browser code); hashing keeps the raw value out of
-- the DB and makes the lookup uniform. workspace_id is NEVER client-supplied — it
-- is derived from the key (inv.2).
--
-- Tenant isolation: workspace_id NOT NULL + the standard RLS policy for MANAGEMENT
-- (list/create/revoke happen in a session workspace context). The public ingest
-- lookup by key_hash runs on the service-role pool (bypasses RLS) because the key
-- itself carries the workspace — there is no session workspace context at ingest.
CREATE TABLE IF NOT EXISTS ingest_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key_hash     text NOT NULL UNIQUE,   -- sha256(raw key); the lookup key
  key_prefix   text NOT NULL,          -- e.g. "pk_live_a1b2c3d4" — shown in the UI
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,            -- non-null = revoked (ingest refuses it)
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS ingest_keys_workspace_idx ON ingest_keys (workspace_id);

ALTER TABLE ingest_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingest_keys;
CREATE POLICY tenant_isolation ON ingest_keys
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
