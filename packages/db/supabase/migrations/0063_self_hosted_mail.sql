-- 0063_self_hosted_mail.sql
-- Self-hosted outbound mail: the sending-IP pool, and per-domain DKIM keys.
--
-- Both tables exist so that growing from one IP to many, or onboarding the second
-- sending domain, is rows rather than a rewrite.

-- ── sending_ips ──────────────────────────────────────────────────────────────
-- The pool the MTA sends from. With a single address today this has one row and
-- the selection logic is a no-op; the shape is what lets it grow.
--
-- NOT workspace-scoped: these are platform infrastructure, shared across every
-- authorized company, and are only ever read/written by platform admins. RLS
-- therefore denies all tenant access rather than filtering by workspace_id.
CREATE TABLE IF NOT EXISTS sending_ips (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip            inet NOT NULL UNIQUE,
  ptr_hostname  text NOT NULL,
  provider      text NOT NULL,                       -- hetzner | linode | ...
  region        text,
  -- Transactional and marketing must never share an address: transactional mail
  -- is high-engagement and protects reputation, marketing risks it.
  stream        text NOT NULL CHECK (stream IN ('transactional', 'marketing')),
  -- Warmup is per-IP: a new address ramps on its own without disturbing
  -- established ones.
  warmup_stage  int  NOT NULL DEFAULT 0,
  daily_cap     int  NOT NULL DEFAULT 50,
  enabled       boolean NOT NULL DEFAULT false,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sending_ips ENABLE ROW LEVEL SECURITY;
-- Platform-admin only: there is no workspace_id to filter on, so no tenant may
-- read the pool. Backend Lambdas use the service role, which bypasses RLS.
DROP POLICY IF EXISTS tenant_isolation ON sending_ips;
CREATE POLICY tenant_isolation ON sending_ips
  USING (app_is_platform_admin());

-- ── domain_dkim_keys ─────────────────────────────────────────────────────────
-- One signing key per (sending domain, selector). Two selectors per domain exist
-- so a key can be rotated without a gap: publish the new key on the unused
-- selector, switch signing over, then retire the old one.
--
-- The PRIVATE key is envelope-encrypted with the same secret-crypto used for
-- every other tenant secret, and is never returned over the API.
CREATE TABLE IF NOT EXISTS domain_dkim_keys (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sending_domain_id uuid NOT NULL REFERENCES sending_domains(id) ON DELETE CASCADE,
  selector          text NOT NULL CHECK (selector IN ('s1', 's2')),
  -- The public half, as published in the TXT record we host.
  public_key        text NOT NULL,
  -- Encrypted PKCS#8 private key. Write-only over the API.
  private_key_enc   text NOT NULL,
  -- Whether this selector is the one currently signing.
  active            boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sending_domain_id, selector)
);

CREATE INDEX IF NOT EXISTS domain_dkim_keys_ws_domain_idx
  ON domain_dkim_keys (workspace_id, sending_domain_id);

ALTER TABLE domain_dkim_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON domain_dkim_keys;
CREATE POLICY tenant_isolation ON domain_dkim_keys
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
