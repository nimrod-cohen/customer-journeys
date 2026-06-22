-- 0044_send_reason_and_default_country.sql
-- Send-result VISIBILITY + recipient ADDRESSING.
--
-- (1) messages_log.reason — WHY a send was skipped/failed (a human string, e.g.
--     'recipient has no phone', 'invalid phone number', 'frequency cap reached',
--     'recipient suppressed', or a captured provider error). NULL for a successful
--     send. Surfaced in the activity feed (detail = COALESCE(reason, status)).
--     Additive nullable column on an existing table → no new RLS (the table's
--     workspace_id policy already covers it).
ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS reason text;

-- (2) company_channel_config.default_country — the ISO 3166-1 alpha-2 country
--     (e.g. 'IL') used to NORMALIZE national phone numbers (leading 0 / no +) into
--     E.164 before handing them to the SMS/WhatsApp provider. NULL → no default
--     (only already-E.164 numbers normalize). Additive nullable column.
ALTER TABLE company_channel_config ADD COLUMN IF NOT EXISTS default_country text;
