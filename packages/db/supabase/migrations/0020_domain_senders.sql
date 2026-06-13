-- 0020_domain_senders.sql
-- Named senders per sending domain (§10). A workspace's verified sending domain
-- can have several human-friendly "From" identities — e.g. "Support"
-- <support@mail.acme.com>, "Sales" <sales@mail.acme.com>. Each row is one sender:
-- a display name + a full email address whose domain is captured separately so
-- the list can be grouped/filtered by domain. The address must belong to its
-- domain (enforced in app code). Workspace-scoped + RLS like every tenant table.
CREATE TABLE IF NOT EXISTS domain_senders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  domain       text NOT NULL,                         -- the sending domain (e.g. mail.acme.com)
  name         text NOT NULL,                         -- display name ("Support")
  email        citext NOT NULL,                       -- full address (support@mail.acme.com), must be @domain
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)                         -- one entry per address per workspace
);
CREATE INDEX IF NOT EXISTS domain_senders_workspace_domain_idx ON domain_senders (workspace_id, domain);

-- Tenant isolation: same standard policy as every tenant-scoped table (§3, 0006).
ALTER TABLE domain_senders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON domain_senders;
CREATE POLICY tenant_isolation ON domain_senders
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
