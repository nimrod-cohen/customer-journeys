-- A bounce/complaint report names a message only by its provider message id. Both
-- the inbound-report lookup and the activity log join on it, and without an index
-- each one scans every message the platform has ever sent.
CREATE INDEX IF NOT EXISTS messages_log_ses_message_id_idx
  ON messages_log (ses_message_id)
  WHERE ses_message_id IS NOT NULL;

-- The subject line as this recipient received it (merge tags rendered), so a send
-- or a bounce can say what the message was about. NULL for text sends and for
-- rows written before this column existed.
ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS subject text;
