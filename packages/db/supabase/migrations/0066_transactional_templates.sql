-- 0066_transactional_templates.sql
-- Transactional email: a designed template, triggered by API with parameters.
--
-- The template is addressed by a STABLE KEY ('otp', 'password-reset'), not by its
-- uuid. Integrators hardcode that key in their own code, so a key lets the template
-- behind it be redesigned, or replaced entirely, without anyone redeploying.

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS transactional_key text;

COMMENT ON COLUMN email_templates.transactional_key IS
  'Stable key for API-triggered transactional sends, e.g. ''otp''. NULL for ordinary templates.';

-- Unique per workspace, and only among templates that HAVE a key: a workspace may
-- hold any number of ordinary templates, but 'otp' must resolve to exactly one.
CREATE UNIQUE INDEX IF NOT EXISTS email_templates_transactional_key_uniq
  ON email_templates (workspace_id, transactional_key)
  WHERE transactional_key IS NOT NULL;
