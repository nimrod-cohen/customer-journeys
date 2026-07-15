// Object storage for uploaded images (§11). An S3-compatible seam so the same
// code targets Cloudflare R2 (chosen: free egress + CDN), AWS S3, Backblaze B2,
// etc. — the provider is pure env config. When UNCONFIGURED it returns null and
// the asset handlers fall back to the legacy base64-in-Postgres path (dev/tests),
// exactly like the local SES mock. Injected via LocalApiDeps.storage so tests can
// assert the exact put/delete without touching the network.
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export interface ObjectStorage {
  /** Store bytes at `key` with the given content type (immutably cacheable). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Best-effort delete of the object at `key`. */
  del(key: string): Promise<void>;
  /** The public, CDN-served URL for `key` (e.g. https://assets.on-grow.com/<key>). */
  publicUrl(key: string): string;
}

/**
 * Build an R2 (S3-compatible) storage client from env, or null if not fully
 * configured. Requires R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE_URL — set these (in prod, Fly secrets) to
 * switch image storage from Postgres to the bucket. `region:'auto'` +
 * forcePathStyle + WHEN_REQUIRED checksums are the R2-compatible S3 settings.
 */
export function r2StorageFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStorage | null {
  const endpoint = env.R2_ENDPOINT;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const publicBase = env.R2_PUBLIC_BASE_URL;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !publicBase) return null;
  const client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  const base = publicBase.replace(/\/+$/, '');
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    },
    async del(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    publicUrl(key) {
      return `${base}/${key}`;
    },
  };
}

/** The R2 object key for an asset — workspace-prefixed + unguessable uuid. */
export function assetObjectKey(workspaceId: string, assetId: string): string {
  return `assets/${workspaceId}/${assetId}`;
}
