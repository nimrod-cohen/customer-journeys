-- The email designer's change history, kept so it survives leaving the editor.
-- One row per document change (or undo/redo), holding the design as it was BEFORE
-- that change; the editor rebuilds its History panel and undo from the newest
-- rows. Capped in code to the last 100 per template.
CREATE TABLE IF NOT EXISTS email_template_history (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  template_id  uuid NOT NULL REFERENCES email_templates (id) ON DELETE CASCADE,
  action       text NOT NULL,
  snapshot     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_template_history_template_idx ON email_template_history (template_id, id);

ALTER TABLE email_template_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON email_template_history;
CREATE POLICY tenant_isolation ON email_template_history
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
