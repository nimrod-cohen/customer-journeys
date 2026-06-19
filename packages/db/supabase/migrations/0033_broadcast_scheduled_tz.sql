-- The IANA timezone a scheduled broadcast's send time was expressed in. The send
-- instant itself is always stored as `scheduled_at` (timestamptz / UTC); this
-- column records the wall-clock zone the user chose so the wizard can round-trip
-- the value on edit and the list can show the time in that zone. NULL for drafts
-- and send-now broadcasts (no chosen time).
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS scheduled_tz text;
