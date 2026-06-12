-- 0016_template_design_and_kinds.sql
-- The custom email designer (§11 — replaces GrapesJS) stores its editable design
-- JSON alongside the derived MJML, and templates split into:
--   kind='library' — the reusable templates shown in the Templates screen, and
--   kind='copy'    — a per-broadcast/campaign CLONE of a library template
--                    (source_template_id points home). Copies are independently
--                    mutable + re-editable without touching the library original.
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS design jsonb,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'library',
  ADD COLUMN IF NOT EXISTS source_template_id uuid REFERENCES email_templates(id);

CREATE INDEX IF NOT EXISTS email_templates_workspace_kind_idx
  ON email_templates (workspace_id, kind);
