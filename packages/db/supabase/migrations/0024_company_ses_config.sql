-- 0024_company_ses_config.sql
-- Per-COMPANY Amazon SES credentials (§10). Each company brings its own AWS SES
-- account: access key, secret, and region. The app builds an SES client from the
-- company's config when verifying/sending for that company's domains. One row per
-- company. The secret is write-only over the API (never returned).
--
-- NOTE: stored as-is here (same posture as workspace_api_keys: protected by RLS +
-- infra). Production should hold the secret in AWS Secrets Manager / KMS, not in
-- the row — this column is the local/dev store.
CREATE TABLE IF NOT EXISTS company_ses_config (
  company_id        uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  region            text NOT NULL,
  access_key_id     text NOT NULL,
  secret_access_key text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Company-scoped RLS, mirroring the companies table policy (0012).
ALTER TABLE company_ses_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON company_ses_config;
CREATE POLICY tenant_isolation ON company_ses_config
  USING (
    app_is_platform_admin()
    OR company_id = (SELECT w.company_id FROM workspaces w WHERE w.id = app_current_workspace_id())
  )
  WITH CHECK (app_is_platform_admin());
