-- Workspace activity feed for SYSTEM/admin actions that aren't behavioral events,
-- email-feedback, or sends — e.g. a recipient unsubscribing, or a marketer editing
-- a profile. These deliberately do NOT go into `events` (that table feeds segment
-- rules + the profile's behavioral timeline, and must stay producer-ingested) — so
-- a separate, append-only log keeps the Activity screen comprehensive without
-- polluting behavioral data. Workspace-scoped like every tenant table (inv.1);
-- profile_id is nullable (some actions have no single profile).
CREATE TABLE IF NOT EXISTS activity_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE: a workspace's activity dies with it (and so existing test
  -- teardowns that just DELETE the workspace need no extra cleanup step).
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  profile_id   uuid REFERENCES profiles (id) ON DELETE SET NULL,
  source       text NOT NULL,           -- 'unsubscribe' | 'profile' | …
  type         text NOT NULL,           -- 'unsubscribe' | 'profile_updated' | …
  outcome      text NOT NULL DEFAULT 'info',
  detail       text NOT NULL DEFAULT '',
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_workspace_at_idx ON activity_log (workspace_id, at DESC);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
-- Same workspace policy as every tenant table (user-context connections);
-- service-role backend connections bypass RLS and scope by workspace_id in code.
DROP POLICY IF EXISTS tenant_isolation ON activity_log;
CREATE POLICY tenant_isolation ON activity_log
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
