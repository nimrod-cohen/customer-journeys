-- 0038_open_tracking_and_unsub_attribution.sql
-- Broadcast conversion funnel (§9A/§10): OPEN tracking + per-broadcast unsubscribe
-- attribution. Extends the existing click tracking (0026/0027) so the broadcasts
-- list can show Sent · Delivered · Failed · Opened · Clicked · Unsubscribed.
--
--  - tracked_opens: when a workspace enables link tracking, the dispatcher embeds
--    a 1x1 pixel `<img src="<base>/o/<token>">` whose token is DETERMINISTIC per
--    (workspace, broadcast|campaign, profile). The public /o/<token> endpoint
--    returns the gif and upsert-records the open. One row per (token) ⇒ one row
--    per (broadcast|campaign, profile), so counting rows = DISTINCT-profile opens
--    (repeat loads only bump `opens`). Workspace-scoped + RLS like tracked_links.
--  - email_events gains broadcast_id/campaign_id so an unsubscribe (and any future
--    feedback) can be attributed to the source send. The unsubscribe POST writes
--    an email_events row (type='unsubscribe') carrying these ids, so the funnel can
--    count unsubscribes per broadcast. (The existing idempotency unique index keys
--    on (workspace_id, ses_message_id, type); an unsubscribe has a NULL
--    ses_message_id, and NULLs are distinct, so it never collides.)

CREATE TABLE IF NOT EXISTS tracked_opens (
  token         text PRIMARY KEY,                       -- unguessable id used in /o/<token>; deterministic per (ws, source, profile)
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  broadcast_id  uuid REFERENCES broadcasts(id),
  campaign_id   uuid REFERENCES campaigns(id),
  profile_id    uuid REFERENCES profiles(id),
  opens         int  NOT NULL DEFAULT 0,                -- total loads (a person may open repeatedly)
  first_open_at timestamptz,
  last_open_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracked_opens_workspace_broadcast_idx ON tracked_opens (workspace_id, broadcast_id);
CREATE INDEX IF NOT EXISTS tracked_opens_workspace_campaign_idx  ON tracked_opens (workspace_id, campaign_id);

ALTER TABLE tracked_opens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tracked_opens;
CREATE POLICY tenant_isolation ON tracked_opens
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());

-- Per-send attribution for feedback rows (e.g. an unsubscribe). Nullable: SES
-- feedback (delivery/bounce/complaint) keeps attributing via ses_message_id, but
-- an unsubscribe (which has no SES message id) carries the source broadcast/campaign.
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS broadcast_id uuid REFERENCES broadcasts(id);
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS campaign_id  uuid REFERENCES campaigns(id);
CREATE INDEX IF NOT EXISTS email_events_workspace_broadcast_idx ON email_events (workspace_id, broadcast_id);
CREATE INDEX IF NOT EXISTS email_events_workspace_campaign_idx  ON email_events (workspace_id, campaign_id);
