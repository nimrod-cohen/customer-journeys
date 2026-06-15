-- 0028_email_envelope.sql
-- The email envelope (From / To / Subject) lives on the EMAIL INSTANCE — the
-- email_templates row — NOT on the broadcast/campaign. Attaching a template to a
-- broadcast/campaign CLONES it (kind='copy'), so each send has its own editable
-- envelope. Edited in the email editor (TemplateEditor) alongside the body.
--   subject     — the subject line (merge tags allowed)
--   sender_id   — optional named "From" (a verified-domain domain_senders row);
--                 null → the no-reply@<from_domain> fallback
--   to_address  — the recipient token, default '{{customer.email}}' (rendered per
--                 recipient at send; falls back to the profile email)
ALTER TABLE email_templates ADD COLUMN subject    text;
ALTER TABLE email_templates ADD COLUMN sender_id  uuid REFERENCES domain_senders(id) ON DELETE SET NULL;
ALTER TABLE email_templates ADD COLUMN to_address text NOT NULL DEFAULT '{{customer.email}}';
