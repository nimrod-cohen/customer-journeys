-- 0011_workspace_settings.sql
-- Per-workspace settings bag (jsonb). First setting: `lowercase_emails` — when
-- true (the default), the workspace enforces all customer emails to lowercase on
-- write (manual create/edit + ingestion). Email matching is already
-- case-insensitive (citext); this governs the STORED form.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{"lowercase_emails": true}'::jsonb;
