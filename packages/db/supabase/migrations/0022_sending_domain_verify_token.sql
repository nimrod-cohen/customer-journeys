-- 0022_sending_domain_verify_token.sql
-- Real domain-ownership verification (§10). Each sending domain gets a unique
-- token; the owner publishes a TXT record `_cdp-verify.<domain> = cdp-verify=<token>`
-- and the system VERIFIES by actually looking that record up in DNS (no auto-flip).
ALTER TABLE sending_domains
  ADD COLUMN IF NOT EXISTS verify_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '');

-- The previous build flipped domains to verified WITHOUT any DNS check. Reset them
-- so verification reflects reality again (they must pass a real DNS lookup).
UPDATE sending_domains SET verified = false, verified_at = NULL WHERE verified = true;
