-- 0018_asset_folders.sql
-- The image gallery (§11): every uploaded asset belongs to a folder ('' = root;
-- nested paths like 'products/2026' allowed) so the gallery can be browsed by
-- subfolder. Purely organizational — serving stays public-by-uuid.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS folder text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS assets_workspace_folder_idx ON assets (workspace_id, folder);
