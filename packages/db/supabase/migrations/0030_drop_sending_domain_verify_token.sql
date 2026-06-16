-- 0030_drop_sending_domain_verify_token.sql
-- Drop the dead `verify_token` column (migration 0022). That TXT-token
-- ownership-verification approach was superseded by Amazon SES Easy-DKIM
-- (migration 0023 — `ses_identity` + `dkim_tokens`, verified via SES
-- DkimStatus). The column is referenced by NO application code; remove the
-- leftover.
ALTER TABLE sending_domains DROP COLUMN IF EXISTS verify_token;
