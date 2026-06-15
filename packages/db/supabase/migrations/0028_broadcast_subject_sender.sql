-- 0028_broadcast_subject_sender.sql
-- Per-send envelope fields (§9A/§10 follow-up): a broadcast carries its OWN
-- subject and an optional named sender (a row in domain_senders, which only
-- exists for a verified domain). Campaign send-action nodes carry the same two
-- fields inside the campaign `definition` jsonb (no column needed there).
-- The recipient ("To") is always the enrolled profile's email, so it is not
-- stored — the dispatcher sends to profile.email.
ALTER TABLE broadcasts ADD COLUMN subject   text;
ALTER TABLE broadcasts ADD COLUMN sender_id uuid REFERENCES domain_senders(id) ON DELETE SET NULL;
