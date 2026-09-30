-- A sending domain may sign with its OWN key instead of the deployment's shared one.
--
-- The self-hosted model signs every customer domain with one key file, so adding a
-- domain needs no work on the mail server. But a domain that ALREADY has a DKIM key
-- published — one the mail server also holds — should be able to keep it: forcing it
-- onto the shared key means editing a record that is already correct, for no gain.
--
-- NULL means "use the deployment's SELF_HOSTED_DKIM_PUBLIC_KEY", which is every
-- domain unless a platform admin says otherwise. Only the PUBLIC half lives here;
-- the private half never leaves the mail server.
ALTER TABLE sending_domains
  ADD COLUMN IF NOT EXISTS dkim_public_key text;

COMMENT ON COLUMN sending_domains.dkim_public_key IS
  'Public half of a key this domain signs with instead of the shared one. NULL = the deployment default. The mail server must hold the matching private key.';
