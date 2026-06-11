-- 0015_campaign_keep_while_in.sql
-- A campaign may require its enrollees to STAY IN a segment: when a profile LEAVES
-- that segment (e.g. ages out of a time window), its active enrollment is
-- completed/exited. §9B + the segments-eval time-window direction. NULL = the
-- enrollment is not membership-gated (the default).
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS keep_while_in_segment uuid REFERENCES segments(id);
