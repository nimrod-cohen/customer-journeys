-- 0023_sending_domain_ses_dkim.sql
-- Verify sending domains with REAL Amazon SES Easy-DKIM (§10/§10A) instead of a
-- placeholder TXT token. Each domain becomes its own SES email identity; SES
-- returns 3 DKIM CNAME tokens to publish, and the verification GATE is SES's own
-- DkimStatus = SUCCESS. Store the identity + tokens per domain.
ALTER TABLE sending_domains
  ADD COLUMN IF NOT EXISTS ses_identity text,
  ADD COLUMN IF NOT EXISTS dkim_tokens  text[] NOT NULL DEFAULT '{}';
