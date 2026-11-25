-- What a transactional message WAS, for when a receiver refuses it. We keep no
-- body, and an API caller can fill a template entirely from its own data, so the
-- template key and the domains its links pointed to are the only evidence left.
-- NULL for broadcasts/automations (their content is on the broadcast or node) and
-- for rows written before these columns existed.
ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS template_key text;
ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS link_hosts text[];
