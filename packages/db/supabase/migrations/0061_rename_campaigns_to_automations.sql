-- 0061_rename_campaigns_to_automations.sql
-- Product rename: "Campaign" → "Automation" EVERYWHERE, including the schema. Rename
-- the three campaign tables and every campaign_id column. Data is preserved (RENAME
-- keeps rows, indexes, constraints, RLS policies — only the name changes). Historical
-- migrations 0001..0060 are left as-is (append-only log); this migration converges
-- both existing DBs (prod) and freshly-migrated ones to the new names.
--
-- NOTE (deploy): a table/column rename is a coordinated cutover — the code is renamed
-- in lockstep. During the rolling deploy there is a brief window where an old instance
-- may error on an automation query until it's replaced. Acceptable at this scale.
ALTER TABLE campaigns             RENAME TO automations;
ALTER TABLE campaign_enrollments  RENAME TO automation_enrollments;
ALTER TABLE campaign_versions     RENAME TO automation_versions;

ALTER TABLE automation_enrollments RENAME COLUMN campaign_id TO automation_id;
ALTER TABLE automation_versions    RENAME COLUMN campaign_id TO automation_id;
ALTER TABLE outbox                 RENAME COLUMN campaign_id TO automation_id;
ALTER TABLE messages_log           RENAME COLUMN campaign_id TO automation_id;
ALTER TABLE email_events           RENAME COLUMN campaign_id TO automation_id;
ALTER TABLE tracked_links          RENAME COLUMN campaign_id TO automation_id;
ALTER TABLE tracked_opens          RENAME COLUMN campaign_id TO automation_id;
