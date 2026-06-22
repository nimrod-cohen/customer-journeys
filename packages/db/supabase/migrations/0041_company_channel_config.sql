-- 0041_company_channel_config.sql
-- Per-COMPANY text-channel (SMS / WhatsApp) provider credentials. Mirrors
-- company_ses_config (0024): each company brings its own gateway account. This
-- phase wires the real "019" Israeli SMS gateway — a static-bearer JSON POST.
-- The dispatcher builds a @cdp/channels ChannelProvider from this config when a
-- workspace's company has a row; with NO row it falls back to the deterministic
-- MOCK provider (so dev/tests/e2e stay green without any credentials).
--
-- One row per company (SMS for now). The bearer (`secret`) is write-only over the
-- API (never returned) and stored as an encryption envelope via @cdp/db
-- secret-crypto, exactly like company_ses_config.secret_access_key.
--
-- NOTE: same posture as company_ses_config — production should hold the secret in
-- AWS Secrets Manager / KMS, not in the row; this column is the local/dev store.
CREATE TABLE IF NOT EXISTS company_channel_config (
  company_id  uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  provider    text NOT NULL DEFAULT '019',
  api_url     text NOT NULL,
  username    text NOT NULL,
  source      text NOT NULL,
  secret      text NOT NULL,           -- encrypted bearer (write-only over the API)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Company-scoped RLS, mirroring company_ses_config (0024) / companies (0012).
ALTER TABLE company_channel_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON company_channel_config;
CREATE POLICY tenant_isolation ON company_channel_config
  USING (
    app_is_platform_admin()
    OR company_id = (SELECT w.company_id FROM workspaces w WHERE w.id = app_current_workspace_id())
  )
  WITH CHECK (app_is_platform_admin());
