-- 0007_email_event_idempotency.sql
-- Phase 8 (§10, §17 phase 8): idempotency key for SES feedback events.
--
-- A re-delivered SNS notification (SES → SNS → Feedback Lambda) must produce
-- exactly ONE email_events row. The dedupe key is (workspace_id, ses_message_id,
-- type): one row per (workspace, SES message, event type). The Feedback Lambda's
-- buildEmailEventInsert uses `ON CONFLICT (workspace_id, ses_message_id, type)
-- DO NOTHING` against this index so replays are no-ops and a soft-bounce count
-- never advances on a replay.
--
-- Idempotent: the index is created IF NOT EXISTS so re-applying the migration
-- against an already-migrated database is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS email_events_idempotency_key
  ON email_events (workspace_id, ses_message_id, type);
