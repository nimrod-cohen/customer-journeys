// Image service config + production dependencies (§11). Config (bucket /
// CloudFront base / presign TTL) is read from the environment via small helpers;
// the variant Lambda connects with the SERVICE ROLE (BYPASSRLS) so isolation is
// in-code: it re-derives the workspace from the S3 key prefix (assertKeyInWorkspace)
// and binds workspace_id at $1 in the usage upsert.
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getPool } from '@cdp/db';
import sharp from 'sharp';
import type { PresignHandlerDeps } from './presign-handler.js';
import type { VariantHandlerDeps } from './variant-handler.js';

/** Static config for the image pipeline, sourced from the environment (§11). */
export interface ImageConfig {
  readonly bucket: string;
  /** Public CloudFront base URL images are served from (no trailing slash). */
  readonly cloudFrontBaseUrl: string;
  /** Presigned-PUT TTL in seconds. */
  readonly presignTtlSeconds: number;
}

/** Read image config from the environment with sane local defaults. */
export function loadImageConfig(): ImageConfig {
  return {
    bucket: process.env.IMAGE_BUCKET ?? 'cdp-images',
    cloudFrontBaseUrl: (process.env.IMAGE_CDN_BASE_URL ?? 'https://images.cdp.example').replace(
      /\/+$/,
      '',
    ),
    presignTtlSeconds: Number(process.env.IMAGE_PRESIGN_TTL_SECONDS ?? '900'),
  };
}

/** Build an S3 client honoring AWS_ENDPOINT_URL (LocalStack) when present. */
export function makeS3Client(): S3Client {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  return new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    // SDK v3 defaults to WHEN_SUPPORTED, which signs an x-amz-checksum-crc32
    // header into the presigned PUT URL — a browser/fetch PUT can't reproduce it
    // and S3 rejects the upload. WHEN_REQUIRED keeps presigned PUTs uploadable.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
}

/** Assemble production deps for the presign handler. */
export function makePresignDeps(): PresignHandlerDeps {
  const config = loadImageConfig();
  return {
    s3: makeS3Client(),
    getSignedUrl,
    config,
  };
}

/** Assemble production deps for the S3-triggered variant handler. */
export function makeVariantDeps(): VariantHandlerDeps {
  const pool = getPool();
  const s3 = makeS3Client();
  return {
    s3,
    resize: async (input: Buffer, width: number): Promise<Buffer> =>
      sharp(input).resize({ width, withoutEnlargement: true }).toBuffer(),
    probe: async (input: Buffer) => {
      const meta = await sharp(input).metadata();
      return { width: meta.width ?? 0, height: meta.height ?? 0 };
    },
    runStatement: async (stmt) => {
      await pool.query(stmt.text, stmt.values);
    },
    now: () => new Date(),
  };
}
