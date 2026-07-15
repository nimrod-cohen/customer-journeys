-- 0059_company_r2_config.sql
-- Per-COMPANY object-storage (Cloudflare R2, S3-compatible) credentials for
-- uploaded images. Mirrors company_ses_config (0024) / company_channel_config
-- (0041): each company brings its OWN bucket + keys, so each company pays for its
-- own storage + operations. When a workspace's company has a row, uploads go to
-- that bucket and GET /assets/:id STREAMS the bytes back through the app (same
-- domain — no separate assets.* domain); with NO row, images fall back to
-- base64-in-Postgres (dev/tests need no bucket).
--
-- One row per company. `secret_access_key` is write-only over the API (never
-- returned) and stored as an encryption envelope via @cdp/db secret-crypto,
-- exactly like company_ses_config.secret_access_key.
CREATE TABLE IF NOT EXISTS company_r2_config (
  company_id        uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  endpoint          text NOT NULL,                 -- https://<accountid>.r2.cloudflarestorage.com
  bucket            text NOT NULL,
  access_key_id     text NOT NULL,
  secret_access_key text NOT NULL,                 -- encrypted (write-only over the API)
  region            text NOT NULL DEFAULT 'auto',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Company-scoped RLS, mirroring company_ses_config (0024) / company_channel_config (0041).
ALTER TABLE company_r2_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON company_r2_config;
CREATE POLICY tenant_isolation ON company_r2_config
  USING (
    app_is_platform_admin()
    OR company_id = (SELECT w.company_id FROM workspaces w WHERE w.id = app_current_workspace_id())
  )
  WITH CHECK (app_is_platform_admin());
