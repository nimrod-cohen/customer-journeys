-- Automation exit rules: a rule can take a person OUT of an automation or send them
-- back to the START while they are enrolled (the rules themselves live in the
-- definition JSON, so they version with publish — no column for them).
--
-- exit_reason: why an enrollment ended early, shown on the Journeys tab.
-- restarts:    how many times this enrollment went back to the start. It is part of
--              every send/webhook dedupe key from the first restart on, so a
--              restarted journey sends its steps again instead of being swallowed
--              by the per-(automation, profile, node) at-most-once guard.
ALTER TABLE automation_enrollments
  ADD COLUMN IF NOT EXISTS exit_reason text,
  ADD COLUMN IF NOT EXISTS restarts integer NOT NULL DEFAULT 0;

-- Exit rules look up a person's ACTIVE enrollments on every event / profile change.
CREATE INDEX IF NOT EXISTS automation_enrollments_profile_active_idx
  ON automation_enrollments (workspace_id, profile_id)
  WHERE status = 'active';
