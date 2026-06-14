-- 0027_tracked_links_campaign.sql
-- Link tracking applies to EVERY outgoing email (the dispatcher rewrites links
-- for any send when the workspace enables it), so a tracked link may belong to a
-- campaign as well as a broadcast. Add campaign_id for attribution.
ALTER TABLE tracked_links ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id);
CREATE INDEX IF NOT EXISTS tracked_links_workspace_campaign_idx ON tracked_links (workspace_id, campaign_id);
