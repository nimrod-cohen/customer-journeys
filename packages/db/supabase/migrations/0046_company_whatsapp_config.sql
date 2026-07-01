-- 0046_company_whatsapp_config.sql
-- Per-COMPANY real WhatsApp (Meta Cloud API) credentials. The WhatsApp twin of
-- company_channel_config (0041, which is 019-SMS-shaped: username/source). A real
-- WhatsApp send needs a phone-number id + a permanent access token + an API version
-- — a different shape — so it gets its OWN one-row-per-company table.
--
-- The dispatcher builds a @cdp/channels MetaWhatsAppProvider from this config when a
-- workspace's company has a row; with NO row a WhatsApp send falls back to the
-- deterministic MOCK provider (so dev/tests/e2e stay green without any credentials).
--
-- `access_token` is write-only over the API (never returned) and stored as an
-- encryption envelope via @cdp/db secret-crypto, exactly like company_ses_config /
-- company_channel_config. (Prod should hold it in AWS Secrets Manager / KMS.)
CREATE TABLE IF NOT EXISTS company_whatsapp_config (
  company_id       uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  phone_number_id  text NOT NULL,          -- the WhatsApp phone-number id (sends FROM)
  access_token     text NOT NULL,          -- encrypted permanent system-user token (write-only)
  api_version      text,                   -- e.g. 'v21.0' (null → the adapter's pinned default)
  default_country  text,                   -- ISO 3166-1 alpha-2 for phone normalization (e.g. 'IL')
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Company-scoped RLS, mirroring company_channel_config (0041) / company_ses_config (0024).
ALTER TABLE company_whatsapp_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON company_whatsapp_config;
CREATE POLICY tenant_isolation ON company_whatsapp_config
  USING (
    app_is_platform_admin()
    OR company_id = (SELECT w.company_id FROM workspaces w WHERE w.id = app_current_workspace_id())
  )
  WITH CHECK (app_is_platform_admin());
