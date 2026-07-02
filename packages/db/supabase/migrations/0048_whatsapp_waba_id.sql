-- 0048_whatsapp_waba_id.sql
-- WhatsApp MESSAGE TEMPLATES are managed at the WhatsApp Business ACCOUNT (WABA) level,
-- not the phone number. To create/list/delete templates via the Meta Graph API
-- (POST/GET/DELETE /<WABA_ID>/message_templates) the company must store its WABA ID
-- alongside the sending phone-number id + access token (0046).
--
-- Additive column, no new RLS (company_whatsapp_config is already company-scoped).
ALTER TABLE company_whatsapp_config ADD COLUMN IF NOT EXISTS waba_id text;
