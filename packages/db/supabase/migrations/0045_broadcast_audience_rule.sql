-- 0045 — Broadcast audience as a comprehensive RULE (segment-style AST) with
-- include/exclude segments combined AND/OR, replacing the single-segment pointer.
--
-- A broadcast's audience is now an OPTIONAL §8 rule AST stored in `broadcasts.audience`
-- (the SAME shape as `segments.definition`): profile-attribute + event conditions AND
-- segment-membership leaves ("is / is NOT a member of segment X"), combined with AND/OR
-- groups. Resolution at send time compiles it via `compileWhere` (workspace_id = $1 always
-- prepended) exactly like a segment — dynamic referenced segments are inlined LIVE, manual
-- ones resolve via segment_memberships.
--
-- BACK-COMPAT: legacy broadcasts keep `audience_kind='segment'` + `audience_ref=<segment_id>`
-- and `audience` NULL; the send path falls back to the existing single-segment resolution,
-- and the editor hydrates them as a single "is a member of <segment>" rule. New broadcasts
-- write `audience` (jsonb) with `audience_kind='rule'` and `audience_ref` NULL — so the two
-- legacy columns must become nullable.

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS audience jsonb;

ALTER TABLE broadcasts ALTER COLUMN audience_kind DROP NOT NULL;
ALTER TABLE broadcasts ALTER COLUMN audience_ref DROP NOT NULL;
