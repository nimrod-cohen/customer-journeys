-- Saved email components: reusable blocks (a footer with the unsubscribe link, a
-- header with the logo) inserted into many emails. An email links to one by id
-- and carries a snapshot of its rows (email_templates.design); editing the
-- component re-renders every email that links to it.
CREATE TABLE IF NOT EXISTS email_components (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name         text NOT NULL,
  design       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_components_workspace_idx ON email_components (workspace_id);

ALTER TABLE email_components ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON email_components;
CREATE POLICY tenant_isolation ON email_components
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
