-- 0065_one_email_provider_per_company.sql
--
-- A company sends email through EXACTLY ONE provider: self-hosted SMTP, Amazon SES,
-- or Resend. Never two at once.
--
-- Until now `UNIQUE (company_id, channel, provider)` allowed a company to hold both
-- an `ses` and a `resend` connector, and resolution silently preferred Resend. That
-- is a trap: the connector you configured most recently is not necessarily the one
-- that sends, and the domain-verification flow differs per provider — so a company
-- could verify a domain for SES while actually sending through Resend.
--
-- Also adds the authorization flag for self-hosted sending. Self-hosted mail goes out
-- over OUR IPs and OUR reputation, so it is granted deliberately by a platform admin
-- rather than self-served.

-- ── who may use our own mail server ──────────────────────────────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS self_hosted_mail_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.self_hosted_mail_enabled IS
  'Platform-admin grant: may this company send through our own mail server? Off by default — self-hosted mail spends our IP reputation.';

-- ── one email provider per company ───────────────────────────────────────────
-- Existing data first: if any company already holds several ENABLED email
-- connectors, keep the most recently updated and DISABLE the rest. Disabling
-- rather than deleting keeps the credentials recoverable — the row is still there
-- if the choice was wrong, and re-enabling is a single flag.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY company_id ORDER BY updated_at DESC, id) AS rn
    FROM company_connectors
   WHERE channel = 'email' AND enabled
)
UPDATE company_connectors c
   SET enabled = false, updated_at = now()
  FROM ranked r
 WHERE c.id = r.id AND r.rn > 1;

-- At most ONE enabled email connector per company. Partial, so a company may keep
-- disabled connectors for other providers (switching provider does not throw the
-- old credentials away).
CREATE UNIQUE INDEX IF NOT EXISTS company_connectors_one_enabled_email
  ON company_connectors (company_id)
  WHERE channel = 'email' AND enabled;
