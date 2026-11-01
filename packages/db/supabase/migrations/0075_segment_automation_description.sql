-- An optional free-text note on what a segment or automation is for. Names are
-- short and get reused ("VIP", "Welcome"); the description is where the intent
-- lives so a teammate can tell them apart without opening the rules.
ALTER TABLE segments
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS description text;
