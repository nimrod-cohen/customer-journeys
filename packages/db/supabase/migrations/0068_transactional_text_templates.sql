-- 0068_transactional_text_templates.sql
-- Transactional SMS / WhatsApp: a text template addressable by the same stable
-- key mechanism as a transactional email.
--
-- The key namespace is shared across email and text templates within a workspace
-- (enforced in the API, since a unique index cannot span two tables). That is
-- deliberate: the integrator writes "template": "otp" and should not also have to
-- say which medium it is — the message itself knows.

ALTER TABLE text_templates
  ADD COLUMN IF NOT EXISTS transactional_key text;

COMMENT ON COLUMN text_templates.transactional_key IS
  'Stable key for API-triggered transactional sends, e.g. ''otp-sms''. NULL for ordinary templates.';

CREATE UNIQUE INDEX IF NOT EXISTS text_templates_transactional_key_uniq
  ON text_templates (workspace_id, transactional_key)
  WHERE transactional_key IS NOT NULL;

-- The medium a transactional text goes out on. NULL for ordinary (medium-agnostic)
-- templates: the body is reusable across SMS and WhatsApp, and only a transactional
-- one must commit to a channel, because nothing else picks it at send time.
ALTER TABLE text_templates
  ADD COLUMN IF NOT EXISTS transactional_medium text;

DO $$
BEGIN
  ALTER TABLE text_templates
    ADD CONSTRAINT text_templates_transactional_medium_chk
    CHECK (transactional_medium IS NULL OR transactional_medium IN ('sms', 'whatsapp'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
