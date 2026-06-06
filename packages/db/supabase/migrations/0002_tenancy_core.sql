-- 0002_tenancy_core.sql
-- Tenancy core: workspaces, membership, platform admins, audit log, API key map.
-- See CDP-BUILD-SPEC.md §3, §3A, §6.

-- The company/tenant (plus its sending-identity config and status).
CREATE TABLE workspaces (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'onboarding', -- onboarding|active|suspended
  sending_identity jsonb NOT NULL DEFAULT '{}',        -- {from_domain, ses_identity, dkim_tokens, dmarc_status, config_set, verified, ...}
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Many-to-many: a user may belong to multiple workspaces (switcher in the UI).
CREATE TABLE workspace_users (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id      uuid NOT NULL,                          -- Supabase auth user id
  role         text NOT NULL DEFAULT 'marketer',       -- owner|marketer|accounting
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Platform operators (cross-tenant). NOT workspace-scoped. See §3A.
CREATE TABLE platform_admins (
  user_id    uuid PRIMARY KEY,                         -- Supabase auth user id
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit log for cross-tenant (system-admin) access.
CREATE TABLE admin_audit_log (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL,
  workspace_id uuid,                                   -- which workspace was accessed (if any)
  action       text NOT NULL,
  detail       jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

-- Maps an API Gateway usage-plan key to a workspace (for ingest attribution).
CREATE TABLE workspace_api_keys (
  api_key_id   text PRIMARY KEY,                       -- API Gateway key id
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON workspace_api_keys (workspace_id);
