-- 0067_secret_api_keys.sql
-- A second class of API key: SECRET, for server-side calls.
--
-- The existing pk_live_ key is documented as public and safe to embed in
-- front-end code, because everything it can do is write into the workspace's own
-- data. The transactional send endpoint is different in kind: it makes us deliver
-- mail, from a verified domain, to an address the caller names. A public key there
-- would turn any customer's website source into a spam relay operating under our
-- sending reputation.
--
-- So sending requires a key that was never meant to leave a server.

ALTER TABLE ingest_keys
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'public';

DO $$
BEGIN
  ALTER TABLE ingest_keys ADD CONSTRAINT ingest_keys_kind_chk CHECK (kind IN ('public', 'secret'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN ingest_keys.kind IS
  'public = pk_live_, embeddable, write-only ingest. secret = sk_live_, server-side only, also permits transactional sending.';

-- A secret key is shown once and never again, so key_full must never hold one.
-- Existing rows are all public, which is the correct default for them.
COMMENT ON COLUMN ingest_keys.key_full IS
  'The copyable raw value — public keys only. NULL for secret keys, which are shown once at creation.';
