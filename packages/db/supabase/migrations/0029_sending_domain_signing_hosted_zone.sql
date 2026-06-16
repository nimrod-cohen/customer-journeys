-- 0029_sending_domain_signing_hosted_zone.sql
-- Store the DKIM "signing hosted zone" SES itself reports
-- (DkimAttributes.SigningHostedZone) for each domain identity. The publishable
-- CNAME target is `<token>.<signing_hosted_zone>` — region-specific and
-- AUTHORITATIVE (read from SES), so we never construct `dkim.<region>.amazonses.com`
-- ourselves. This system is multi-region (each company picks its own SES region),
-- so the host MUST come from SES, not a hardcoded rule.
ALTER TABLE sending_domains ADD COLUMN signing_hosted_zone text;
