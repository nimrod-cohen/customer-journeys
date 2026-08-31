-- Outbox retry scheduling.
--
-- A send that fails because our own mail server is rebooting is EARLY, not failed.
-- The dispatcher already returned such a row to `pending`, but nothing carried the
-- "try again later" part: a broadcast drains its outbox exactly once, so rows reset
-- during an outage sat pending forever and those recipients were never mailed.
--
-- `next_attempt_at` is when the row becomes eligible again. NULL means "now" — every
-- existing row stays immediately due, so this migration changes no behaviour on its
-- own. `attempts` (already present, incremented on claim) bounds the retrying.
ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

COMMENT ON COLUMN outbox.next_attempt_at IS
  'When this row may next be claimed; NULL = immediately. Set by the dispatcher''s exponential backoff after a transient send failure.';

-- The sweep asks for "pending rows that are due", newest backoff last. Partial: the
-- table is dominated by terminal `sent` rows that this query never looks at.
CREATE INDEX IF NOT EXISTS outbox_due_idx
  ON outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'sending');
