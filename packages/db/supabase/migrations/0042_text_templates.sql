-- 0042_text_templates.sql
-- A reusable TEXT-template library — plain-text message templates usable for BOTH
-- SMS and WhatsApp (one template serves both mediums; it is medium-AGNOSTIC).
--
-- Unlike email templates (a design/MJML library that is CLONED onto a broadcast/
-- campaign instance), a text template is just a reusable BODY string. Picking one
-- COPIES its body into the send's existing text_body (broadcasts.text_body, or a
-- campaign send node's text_body in the definition jsonb) — copy-on-select, NO
-- live reference and NO new column on broadcasts/campaigns. The body is merge-tag
-- enabled (e.g. {{customer.first_name}}), rendered per recipient at send time.
--
-- Tenant isolation: workspace_id NOT NULL, the standard workspace_id RLS policy,
-- and a workspace_id-leading index — mirroring topics (0040).
CREATE TABLE IF NOT EXISTS text_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name         text NOT NULL,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS text_templates_workspace_idx ON text_templates (workspace_id);

ALTER TABLE text_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON text_templates;
CREATE POLICY tenant_isolation ON text_templates
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
