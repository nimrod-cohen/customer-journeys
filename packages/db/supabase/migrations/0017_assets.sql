-- 0017_assets.sql
-- Uploaded email assets (images referenced by mj-image src). Dev-harness storage
-- is base64 in-row; production swaps the storage for S3+CloudFront behind the
-- same API (§11). Serving is PUBLIC-BY-UUID (the CloudFront model — possession of
-- the unguessable URL grants read, exactly like a CDN image link in an email);
-- uploads are workspace-scoped + capability-gated.
CREATE TABLE IF NOT EXISTS assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  filename     text NOT NULL,
  mime         text NOT NULL,
  data         text NOT NULL,                         -- base64 payload (dev harness)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_workspace_idx ON assets (workspace_id);

-- Tenant isolation: same standard policy as every tenant-scoped table (§3, 0006).
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON assets;
CREATE POLICY tenant_isolation ON assets
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
