-- 0014_campaign_trigger_on.sql
-- A campaign triggered by a segment can fire on ENTER (default, the original
-- behavior) or on EXIT (a profile LEAVING the segment — e.g. aging out of a
-- "active in the last 30 days" window starts a win-back journey). §9B + the
-- segments-eval time-window direction. Enrollment branches on this against the
-- segment_change_log action ('entered' vs 'exited').
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS trigger_on text NOT NULL DEFAULT 'enter';
