-- 0064_postmaster_verification.sql
-- Google Postmaster Tools verification, per sending domain.
--
-- Gmail reports domain reputation and spam rate ONLY through Postmaster Tools, and
-- only to an account that has proven ownership of the domain. There is no API key
-- to hand over.
--
-- Rather than ask every customer to create a Google account, verify their domain
-- and complete an OAuth consent screen, we verify THEIR domain under OUR Postmaster
-- account: a domain may be verified by several accounts independently, each via its
-- own DNS TXT record. So the customer publishes one more record alongside the three
-- CNAMEs they already publish, and never touches Google.
--
-- The token is per-domain and issued by Google when the domain is added to
-- Postmaster Tools, which is why it is stored rather than derived.

ALTER TABLE sending_domains
  -- The value Google issues, e.g. 'google-site-verification=abc123...'. Published
  -- as a TXT record at the domain apex by the customer.
  ADD COLUMN IF NOT EXISTS gpt_verification_token text,
  -- Set once we have seen the token resolve in DNS. Distinct from `verified`, which
  -- gates SENDING: a domain can send perfectly well without Postmaster Tools; this
  -- only gates whether we can SEE its Gmail reputation.
  ADD COLUMN IF NOT EXISTS gpt_verified_at timestamptz;

COMMENT ON COLUMN sending_domains.gpt_verification_token IS
  'Google Postmaster Tools site-verification TXT value; published by the customer, verified under our account.';
COMMENT ON COLUMN sending_domains.gpt_verified_at IS
  'When the verification TXT was last observed in DNS. Reputation visibility only — never gates sending.';
