-- 0021_sending_domains.sql
-- A workspace can have MORE THAN ONE sending domain (§10). Previously a single
-- `workspaces.sending_identity.from_domain`; now a list, each with its own
-- verification state. A domain may be ADDED while unverified (so it can be queued
-- for DNS/DKIM setup), but a domain_sender may only be created for a VERIFIED
-- domain (enforced in app code). The legacy single-domain onboarding wizard still
-- verifies the primary domain and now also records it here as verified.
CREATE TABLE IF NOT EXISTS sending_domains (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  domain       text NOT NULL,
  verified     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  verified_at  timestamptz,
  UNIQUE (workspace_id, domain)
);
CREATE INDEX IF NOT EXISTS sending_domains_workspace_idx ON sending_domains (workspace_id);

-- Tenant isolation: same standard policy as every tenant-scoped table (§3, 0006).
ALTER TABLE sending_domains ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sending_domains;
CREATE POLICY tenant_isolation ON sending_domains
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
