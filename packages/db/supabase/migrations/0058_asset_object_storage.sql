-- 0058_asset_object_storage.sql
-- Move uploaded image storage OUT of Postgres (assets.data base64) and into an
-- S3-compatible object store (Cloudflare R2). A row now records WHERE its bytes
-- live: storage='db' keeps the legacy base64 in `data` (dev/tests + pre-R2 rows);
-- storage='r2' stores only the object KEY (`r2_key`) + byte size, and the bytes
-- live in the bucket, served from R2's CDN. `data` becomes NULLABLE (r2 rows have
-- none). GET /assets/:id keeps working for both (streams db bytes, or 302-redirects
-- to the R2 public URL) so image URLs frozen into saved templates still resolve.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS storage    text NOT NULL DEFAULT 'db';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS r2_key     text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS size_bytes integer;
ALTER TABLE assets ALTER COLUMN data DROP NOT NULL;
