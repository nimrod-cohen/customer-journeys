-- 0001_extensions.sql
-- Required Postgres extensions. See CDP-BUILD-SPEC.md §6.
-- gen_random_uuid() comes from pgcrypto; citext provides case-insensitive emails.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
