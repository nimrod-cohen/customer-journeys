-- 0051_campaign_draft_trigger_on.sql
-- Make the segment-trigger DIRECTION (enter | exit) draft-aware, mirroring
-- draft_trigger_segment_id (0037) and draft_definition. The builder edits the DRAFT;
-- publishing promotes draft_trigger_on -> trigger_on (and clears the draft). NULL =
-- no draft override (the draft's direction equals the live trigger_on).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS draft_trigger_on text;
