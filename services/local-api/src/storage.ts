// Object storage for uploaded images (§11) — PER-COMPANY (like SES / 019 / WhatsApp).
// An S3-compatible seam so each company brings its own Cloudflare R2 bucket + keys
// (they pay their own storage). The app STREAMS bytes through GET /assets/:id (same
// domain — no separate assets.* domain), so the seam needs get() as well as
// put()/del(). A company with no config falls back to base64-in-Postgres (dev/tests
// need no bucket). Built from a config (not env) so it's resolved per company;
// injected as a factory via LocalApiDeps.makeR2Storage so tests use an in-memory
// fake and never touch the network.
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export interface R2Config {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string;
}

export interface ObjectStorage {
  /** Store bytes at `key` with the given content type (immutably cacheable). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Fetch the bytes at `key` (+ its content type), or null if absent. */
  get(key: string): Promise<{ body: Buffer; contentType: string | undefined } | null>;
  /** Best-effort delete of the object at `key`. */
  del(key: string): Promise<void>;
}

/** Build an R2 (S3-compatible) storage client from a company's config. */
export function makeR2Storage(cfg: R2Config): ObjectStorage {
  const client = new S3Client({
    region: cfg.region || 'auto',
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        if (!res.Body) return null;
        const bytes = await res.Body.transformToByteArray();
        return { body: Buffer.from(bytes), contentType: res.ContentType };
      } catch (e) {
        // Missing key (NoSuchKey / 404) → null; anything else re-throws.
        const name = (e as { name?: string }).name;
        if (name === 'NoSuchKey' || name === 'NotFound') return null;
        throw e;
      }
    },
    async del(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
  };
}

/** Factory type (injected via deps so tests substitute an in-memory fake). */
export type R2StorageFactory = (cfg: R2Config) => ObjectStorage;

/** The object key for an asset — workspace-prefixed + the unguessable uuid. */
export function assetObjectKey(workspaceId: string, assetId: string): string {
  return `assets/${workspaceId}/${assetId}`;
}

/**
 * Turn a storage failure into something the person configuring it can act on.
 *
 * The raw S3 error name is not an answer: `AccessDenied` on a bucket that plainly
 * exists means the API token is scoped to a DIFFERENT bucket — R2 will not even
 * admit whether the bucket is there, answering 403 either way. That exact
 * misconfiguration otherwise stays invisible until someone's first image upload
 * 500s, long after whoever set it up has moved on.
 */
export function explainStorageError(err: unknown, bucket: string): string {
  const e = (err ?? {}) as { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  const name = e.name ?? '';
  const code = e.code ?? '';

  if (name === 'NoSuchBucket') {
    return `The bucket “${bucket}” does not exist in this account. Check the name, or create it in Cloudflare R2.`;
  }
  if (name === 'InvalidAccessKeyId') {
    return 'That access key id is not recognised. Copy it again from the R2 API token screen.';
  }
  if (name === 'SignatureDoesNotMatch') {
    return 'The secret access key does not match that access key id. Secrets are shown once — if it was lost, roll the token and paste the new pair.';
  }
  if (name === 'AccessDenied' || status === 403) {
    return `Connected, but this token is not allowed to use “${bucket}”. R2 answers 403 for every bucket a token is not scoped to, so the usual cause is a token scoped to a different bucket — re-create it with Object Read & Write on this one.`;
  }
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT)$/.test(code) || /Timeout|Network/i.test(name)) {
    return 'Could not reach the endpoint. Check the endpoint URL — it is https://<account-id>.r2.cloudflarestorage.com, with your own account id.';
  }
  return e.message || name || 'The storage provider refused the request without saying why.';
}
