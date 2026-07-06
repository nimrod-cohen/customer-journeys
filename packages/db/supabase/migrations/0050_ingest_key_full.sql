-- 0050_ingest_key_full.sql
-- A write key is PUBLIC (embedded in front-end JS), so there is no secrecy benefit
-- to storing only its hash — keep the full value too, so it can be copied again
-- from the UI at any time (like Segment/Mixpanel show their write keys). Nullable:
-- keys minted before this migration remain hash-only (shown by prefix, never
-- revealed). The key_hash lookup is unchanged (still the ingest resolution path).
ALTER TABLE ingest_keys ADD COLUMN IF NOT EXISTS key_full text;
