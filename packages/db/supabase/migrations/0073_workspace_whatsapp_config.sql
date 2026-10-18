-- 0073_workspace_whatsapp_config.sql
-- WhatsApp moves from a per-COMPANY connector to a per-WORKSPACE config. Each
-- workspace connects its own WhatsApp Business phone number to our one platform
-- Meta app.
--
-- `phone_number_id` is UNIQUE ACROSS ALL WORKSPACES: it is the routing key for
-- inbound webhooks (Meta tells us which number a message arrived on, and we map
-- that to exactly one workspace). A number shared by two workspaces would make
-- every inbound message ambiguous.
--
-- `access_token` is write-only over the API and stored as a @cdp/db secret-crypto
-- envelope, like every other provider credential.
CREATE TABLE IF NOT EXISTS workspace_whatsapp_config (
  workspace_id           uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  phone_number_id        text NOT NULL UNIQUE,
  waba_id                text,
  access_token           text NOT NULL,
  api_version            text,
  default_country        text,
  display_phone_number   text,
  verified_name          text,
  enabled                boolean NOT NULL DEFAULT true,
  webhook_subscribed_at  timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspace_whatsapp_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace_whatsapp_config;
CREATE POLICY tenant_isolation ON workspace_whatsapp_config
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());

-- Carry existing company-level config over. A number can belong to ONE workspace,
-- so it goes to the company's OLDEST workspace; the company's other workspaces
-- start unconfigured. The unified connector wins over the legacy table. Secrets
-- are copied verbatim (already envelopes). Idempotent.
INSERT INTO workspace_whatsapp_config
  (workspace_id, phone_number_id, waba_id, access_token, api_version, default_country, enabled)
SELECT DISTINCT ON (src.company_id)
       w.id, src.phone_number_id, src.waba_id, src.access_token, src.api_version, src.default_country, true
  FROM (
    SELECT c.company_id,
           c.config->>'phone_number_id' AS phone_number_id,
           c.config->>'waba_id'         AS waba_id,
           c.secret                     AS access_token,
           c.config->>'api_version'     AS api_version,
           c.config->>'default_country' AS default_country,
           0                            AS pri
      FROM company_connectors c
     WHERE c.channel = 'whatsapp' AND c.provider = 'meta_whatsapp' AND c.enabled
       AND c.secret IS NOT NULL AND coalesce(c.config->>'phone_number_id', '') <> ''
    UNION ALL
    SELECT l.company_id, l.phone_number_id, l.waba_id, l.access_token, l.api_version, l.default_country, 1
      FROM company_whatsapp_config l
  ) src
  JOIN LATERAL (
    SELECT ws.id FROM workspaces ws WHERE ws.company_id = src.company_id
     ORDER BY ws.created_at, ws.id LIMIT 1
  ) w ON true
 ORDER BY src.company_id, src.pri
ON CONFLICT DO NOTHING;

-- The company-level rows stay (dormant) for rollback; nothing reads them any more.
