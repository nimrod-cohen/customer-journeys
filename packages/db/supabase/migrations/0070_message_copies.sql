-- Cc / Bcc addresses recorded on the message they were sent with.
--
-- A bounce report names the address that failed, and the dispatcher trusts that
-- name over the message's own recipient — correctly, since a copy can bounce while
-- the primary is fine. But nothing could check whether the named address was even
-- on the message, so a report naming any address at all would have suppressed it.
-- These columns are what makes that check possible: an address is only actionable
-- if this message actually went to it.
--
-- Deliberately arrays on the message row rather than a child table: they are read
-- once, together, on exactly one code path.
ALTER TABLE messages_log
  ADD COLUMN IF NOT EXISTS cc_addresses  text[],
  ADD COLUMN IF NOT EXISTS bcc_addresses text[];

COMMENT ON COLUMN messages_log.bcc_addresses IS
  'Blind copies. Never rendered into a header or echoed to any recipient — stored only so a bounce naming one can be attributed to it.';
