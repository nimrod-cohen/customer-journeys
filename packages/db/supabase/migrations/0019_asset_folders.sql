-- 0019_asset_folders.sql
-- Persistent gallery folders (§11 asset manager). Folders previously existed only
-- implicitly (distinct assets.folder values); the asset-manager modal lets users
-- CREATE folders before anything is uploaded into them, so they need a row of
-- their own. name is the full path ('logos', 'products/2026').
CREATE TABLE IF NOT EXISTS asset_folders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
ALTER TABLE asset_folders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON asset_folders;
CREATE POLICY tenant_isolation ON asset_folders
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
