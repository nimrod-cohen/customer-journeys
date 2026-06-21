-- 0039_broadcast_medium.sql
-- MULTI-CHANNEL broadcasts (§9A extension): a broadcast can now send over
-- email (the default, unchanged), SMS, or WhatsApp.
--
-- Email keeps using its email INSTANCE (template → MJML → compiled HTML → SES,
-- with the From/To/Subject envelope + verified-domain gate). SMS/WhatsApp carry
-- a single plain-text `text_body` (merge-tag enabled, NO MJML/HTML) sent to the
-- recipient's phone via a channel provider (a deterministic MOCK this phase).
--
-- These are ADDITIVE columns on existing tables — no new table, so no new RLS
-- policy is needed (the parent tables' workspace_id RLS already covers them).

-- The broadcast's channel. Defaults to 'email' so every existing broadcast is
-- unchanged. The check constraint keeps it to the three known channels.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS medium text NOT NULL DEFAULT 'email';
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_medium_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_medium_check
  CHECK (medium IN ('email', 'sms', 'whatsapp'));

-- The SMS/WhatsApp message body (plain text, merge-tag enabled). NULL for email
-- broadcasts (which use their email instance/template instead).
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS text_body text;

-- messages_log records which channel a send went out on (for per-medium stats
-- and the activity feed). Defaults to 'email' so historical rows are unchanged.
ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS medium text NOT NULL DEFAULT 'email';
