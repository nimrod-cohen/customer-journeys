-- Why a queued message has not gone out yet.
--
-- A send that fails transiently returns to `pending` and is retried for hours; one
-- parked for quiet hours waits for the window; one refused by the sending gate is
-- terminal. None of the three writes a messages_log row, and the reason was thrown
-- away — so a broadcast could read "sent" with zero sends and nothing anywhere said
-- why. `last_error` keeps the latest reason on the row, which is what lets the
-- activity log show a message that is waiting, and what it is waiting for.
ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS last_error text;

COMMENT ON COLUMN outbox.last_error IS
  'The most recent reason this row was not sent (transient failure, quiet-hours deferral, or refusal). NULL until something goes wrong.';
