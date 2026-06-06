-- 0006_rls.sql
-- Row-Level Security. See CDP-BUILD-SPEC.md §3, §3A, §6, §13.
--
-- Invariants:
--   * RLS is ENABLED on every tenant-scoped table.
--   * The standard policy restricts rows to the caller's workspace:
--       workspace_id = (auth.jwt() ->> 'workspace_id')::uuid
--   * A NARROW exception lets the cross-tenant system-admin role through when the
--     authorizer-injected `is_platform_admin` claim is true. This is the only
--     deliberate isolation break — keep it narrow (§3A).
--
-- CAVEAT (§3): the Supabase SERVICE ROLE bypasses RLS. Backend processing
-- Lambdas connecting with the service role MUST scope by workspace_id in code;
-- RLS is the guard for user-context (admin app) connections only.

-- Helpers reading the authorizer-injected JWT claims. STABLE so the planner can
-- cache within a statement. Default to false/null when the claim is absent.
CREATE OR REPLACE FUNCTION app_current_workspace_id()
RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'workspace_id', '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (current_setting('request.jwt.claims', true)::jsonb ->> 'is_platform_admin')::boolean,
    false
  )
$$;

-- Convenience: the spec's canonical predicate spelled with auth.jwt() resolves to
-- the same claim. We use the helper functions above so policies stay uniform and
-- the platform-admin exception is consistently narrow.

-- ---------------------------------------------------------------------------
-- Tenant-scoped tables: workspace_id column drives the policy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'profiles',
    'events',
    'profile_features',
    'segments',
    'segment_memberships',
    'segment_change_log',
    'campaigns',
    'campaign_enrollments',
    'broadcasts',
    'email_templates',
    'outbox',
    'messages_log',
    'suppressions',
    'email_events',
    'usage_counters',
    'workspace_api_keys'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (workspace_id = app_current_workspace_id() OR app_is_platform_admin())
         WITH CHECK (workspace_id = app_current_workspace_id() OR app_is_platform_admin())',
      t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- workspaces: not carrying a workspace_id column, scoped by its own id.
-- ---------------------------------------------------------------------------
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspaces
  USING (id = app_current_workspace_id() OR app_is_platform_admin())
  WITH CHECK (id = app_current_workspace_id() OR app_is_platform_admin());

-- ---------------------------------------------------------------------------
-- workspace_users: membership rows scoped by their workspace_id; a user may
-- always see their own membership rows (needed for the workspace switcher).
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_users
  USING (
    workspace_id = app_current_workspace_id()
    OR user_id = (NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', ''))::uuid
    OR app_is_platform_admin()
  )
  WITH CHECK (
    workspace_id = app_current_workspace_id()
    OR app_is_platform_admin()
  );

-- ---------------------------------------------------------------------------
-- platform_admins & admin_audit_log: cross-tenant / platform-only.
-- Only the system-admin (is_platform_admin) may read; not workspace-scoped (§3A).
-- ---------------------------------------------------------------------------
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON platform_admins
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON admin_audit_log
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());

-- ---------------------------------------------------------------------------
-- global_hard_bounces: cross-workspace by design (invalid mailboxes). Readable
-- to any authenticated workspace context for suppression checks; writes are
-- platform/service-role only via the Feedback Lambda.
-- ---------------------------------------------------------------------------
ALTER TABLE global_hard_bounces ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_hard_bounces FORCE ROW LEVEL SECURITY;
CREATE POLICY read_all ON global_hard_bounces
  FOR SELECT
  USING (app_current_workspace_id() IS NOT NULL OR app_is_platform_admin());
CREATE POLICY platform_write ON global_hard_bounces
  FOR ALL
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());
