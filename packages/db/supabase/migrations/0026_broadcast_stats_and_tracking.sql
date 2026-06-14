-- 0026_broadcast_stats_and_tracking.sql
-- Per-broadcast metrics + optional click tracking (§9A/§10).
--
--  - broadcasts.updated_at: drives the "Edited X ago" line.
--  - messages_log.broadcast_id: attribute a send to its broadcast (mirrors the
--    existing campaign_id), so Delivered/Failed/Sent are a simple GROUP BY rather
--    than digging broadcast_id out of outbox.payload JSON.
--  - tracked_links: when a workspace enables link tracking, each (broadcast, url)
--    gets a short token; the app's /t/<token> endpoint 302-redirects to `url` and
--    increments `clicks`. The Clicked metric sums these per broadcast.
ALTER TABLE broadcasts     ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE messages_log   ADD COLUMN IF NOT EXISTS broadcast_id uuid REFERENCES broadcasts(id);
CREATE INDEX IF NOT EXISTS messages_log_workspace_broadcast_idx ON messages_log (workspace_id, broadcast_id);

CREATE TABLE IF NOT EXISTS tracked_links (
  token        text PRIMARY KEY,                        -- unguessable short id used in /t/<token>
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  broadcast_id uuid REFERENCES broadcasts(id),
  url          text NOT NULL,                           -- the original destination
  clicks       int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracked_links_workspace_broadcast_idx ON tracked_links (workspace_id, broadcast_id);

ALTER TABLE tracked_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tracked_links;
CREATE POLICY tenant_isolation ON tracked_links
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
