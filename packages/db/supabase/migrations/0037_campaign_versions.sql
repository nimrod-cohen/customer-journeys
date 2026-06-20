-- Campaign VERSIONING + publish-scope (§9B builder).
--
-- A campaign now distinguishes its LIVE definition (what the runner reads —
-- `campaigns.definition` + `campaigns.trigger_segment_id`, UNCHANGED) from an
-- in-progress DRAFT working copy the builder autosaves. Publishing a draft
-- snapshots it as an append-only `campaign_versions` row, promotes it to live,
-- and clears the draft. Reverting loads a prior version BACK into the draft
-- (never destroying history). The runner is untouched: it keeps reading the
-- live columns.
--
-- Tenant isolation is unchanged (inv.1): every version row carries
-- workspace_id NOT NULL; RLS keys on workspace_id with the platform-admin
-- exception, exactly like peer tables.

-- Append-only published-version history for a campaign.
CREATE TABLE IF NOT EXISTS campaign_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id),
  -- A version dies with its campaign (history is meaningless without it).
  campaign_id         uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  version             int  NOT NULL,                 -- 1-based, monotonic per campaign
  name                text NOT NULL,                 -- the published label
  definition          jsonb NOT NULL,                -- the published DSL snapshot
  trigger_segment_id  uuid,                          -- the published segment-entry trigger (if any)
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,                          -- the publishing user (ctx.userId)
  UNIQUE (campaign_id, version)
);
-- workspace_id-leading index (inv.1 access pattern: list a workspace's versions).
CREATE INDEX IF NOT EXISTS campaign_versions_workspace_campaign_idx
  ON campaign_versions (workspace_id, campaign_id, version DESC);

ALTER TABLE campaign_versions ENABLE ROW LEVEL SECURITY;
-- Same workspace policy as every tenant table (user-context connections);
-- service-role backend connections bypass RLS and scope by workspace_id in code.
DROP POLICY IF EXISTS tenant_isolation ON campaign_versions;
CREATE POLICY tenant_isolation ON campaign_versions
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());

-- The campaign gains a DRAFT working copy (NULL ⇒ no unsaved draft, draft == live)
-- and a pointer to the currently-published live version. `definition` and
-- `trigger_segment_id` REMAIN the live values the runner reads.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS draft_definition          jsonb;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS draft_trigger_segment_id  uuid;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS active_version_id         uuid REFERENCES campaign_versions (id);
