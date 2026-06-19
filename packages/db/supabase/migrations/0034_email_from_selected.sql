-- Whether the email's From was INTENTIONALLY chosen. The From is mandatory: the
-- user must explicitly pick a sender — which MAY be the no-reply@<domain> default,
-- but it has to be a deliberate selection, not an implicit fallback. `sender_id`
-- alone can't express this (NULL means both "no-reply" and "not yet chosen"), so
-- this flag records that a choice was made. A broadcast can't be sent until its
-- email has `from_selected = true`. Defaults false; the editor sets it when the
-- From dropdown is touched, and cloneTemplate carries it onto the working copy.
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS from_selected boolean NOT NULL DEFAULT false;
