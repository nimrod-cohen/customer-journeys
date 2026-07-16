-- 0060_company_connectors.sql
-- Unified per-company CONNECTOR registry (supersedes the per-provider config tables
-- company_ses_config / company_channel_config / company_whatsapp_config). A connector
-- powers a messaging CHANNEL (email | sms | whatsapp) via a PROVIDER (ses | resend |
-- 019 | meta_whatsapp). A channel is "enabled" for a company when ≥1 connector that can
-- actually send on it is connected; the app gates broadcasts + campaigns on that.
-- Extensible: new providers are just new rows (no schema change).
--
-- `secret` is the encrypted credential (write-only over the API) — same envelope crypto
-- as the tables it replaces. The old per-provider tables are KEPT (dormant) for one
-- release for rollback; the data is copied here and all reads/writes move to this table.
CREATE TABLE IF NOT EXISTS company_connectors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel     text NOT NULL,               -- 'email' | 'sms' | 'whatsapp'
  provider    text NOT NULL,               -- 'ses' | 'resend' | '019' | 'meta_whatsapp'
  config      jsonb NOT NULL DEFAULT '{}',  -- non-secret provider config
  secret      text,                         -- encrypted credential (write-only over the API)
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, channel, provider)
);
CREATE INDEX IF NOT EXISTS company_connectors_company_idx ON company_connectors (company_id);

-- Company-scoped RLS, mirroring company_ses_config (0024) / company_channel_config (0041).
ALTER TABLE company_connectors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON company_connectors;
CREATE POLICY tenant_isolation ON company_connectors
  USING (
    app_is_platform_admin()
    OR company_id = (SELECT w.company_id FROM workspaces w WHERE w.id = app_current_workspace_id())
  )
  WITH CHECK (app_is_platform_admin());

-- Migrate existing per-provider configs → connectors (idempotent). Secrets copied
-- VERBATIM (already envelope-encrypted).
INSERT INTO company_connectors (company_id, channel, provider, config, secret, enabled)
SELECT company_id, 'email', 'ses',
       jsonb_build_object('region', region, 'access_key_id', access_key_id),
       secret_access_key, true
  FROM company_ses_config
ON CONFLICT (company_id, channel, provider) DO NOTHING;

INSERT INTO company_connectors (company_id, channel, provider, config, secret, enabled)
SELECT company_id, 'sms', '019',
       jsonb_build_object('api_url', api_url, 'username', username, 'source', source, 'default_country', default_country),
       secret, true
  FROM company_channel_config
ON CONFLICT (company_id, channel, provider) DO NOTHING;

INSERT INTO company_connectors (company_id, channel, provider, config, secret, enabled)
SELECT company_id, 'whatsapp', 'meta_whatsapp',
       jsonb_build_object('phone_number_id', phone_number_id, 'waba_id', waba_id, 'api_version', api_version, 'default_country', default_country),
       access_token, true
  FROM company_whatsapp_config
ON CONFLICT (company_id, channel, provider) DO NOTHING;
