// One-time backfill: move existing base64-in-Postgres images (assets.storage='db')
// into R2. Idempotent — only touches 'db' rows, safe to re-run. Self-contained
// (pg + @aws-sdk/client-s3 directly) so it runs in the Fly container via plain
// `node`. Requires DATABASE_URL (or DATABASE_POOL_URL) + the R2_* env the app uses.
//
//   fly ssh console -a cdp-journeys -C "sh -lc 'cd /app && node scripts/backfill-assets-to-r2.mjs'"
import pg from 'pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE_URL } = process.env;
if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PUBLIC_BASE_URL) {
  console.error('R2 not configured — set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE_URL');
  process.exit(1);
}
const conn = process.env.DATABASE_URL ?? process.env.DATABASE_POOL_URL;
if (!conn) {
  console.error('DATABASE_URL (or DATABASE_POOL_URL) is required');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
const pool = new pg.Pool({ connectionString: conn });

const { rows } = await pool.query(
  "SELECT id, workspace_id, mime, data FROM assets WHERE storage = 'db' AND data IS NOT NULL",
);
console.log(`backfilling ${rows.length} asset(s) to R2 bucket ${R2_BUCKET}...`);
let migrated = 0;
let failed = 0;
for (const a of rows) {
  const key = `assets/${a.workspace_id}/${a.id}`;
  try {
    const bytes = Buffer.from(a.data, 'base64');
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: bytes,
        ContentType: a.mime,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    await pool.query("UPDATE assets SET storage = 'r2', r2_key = $2, size_bytes = $3, data = NULL WHERE id = $1", [
      a.id,
      key,
      bytes.length,
    ]);
    migrated++;
  } catch (e) {
    console.error(`FAILED ${a.id}: ${String(e)}`);
    failed++;
  }
}
console.log(`done: ${migrated} migrated, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
