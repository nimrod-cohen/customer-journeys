// Presign request builder (§11, CLAUDE.md invariant 2).
//
// The editor asks for a presigned S3 PUT URL; the browser then uploads directly.
// This pure function builds the PutObjectCommand INPUT (Bucket/Key/ContentType)
// — the handler turns it into a presigned URL. Two non-negotiables:
//   1. the workspace comes from the AUTHORIZER CONTEXT, never the client body —
//      so a caller cannot mint a URL targeting another workspace's prefix; and
//   2. the content type is whitelisted (png/jpeg/webp/gif) — no SVG/script
//      payloads, no arbitrary uploads.
import { buildImageKey } from './key.js';

/** The image content types we allow to be uploaded (§11). */
export const ALLOWED_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/** Thrown when an upload's content type is not in the whitelist. */
export class ContentTypeError extends Error {
  constructor(contentType: string) {
    super(`ContentTypeError: content type not allowed: ${contentType}`);
    this.name = 'ContentTypeError';
  }
}

/** Inputs to a presign request. workspaceId comes from the authorizer context. */
export interface PresignRequestInput {
  readonly bucket: string;
  /** From the authorizer context — NEVER from the client body (§13). */
  readonly workspaceId: string;
  /** Client-suggested filename (sanitized into the key; cannot escape prefix). */
  readonly filename: string;
  /** Declared content type; must be whitelisted. */
  readonly contentType: string;
}

/** A minimal PutObjectCommand input shape (the bits we set). */
export interface PutObjectInput {
  readonly Bucket: string;
  readonly Key: string;
  readonly ContentType: AllowedContentType;
}

/** Type guard: is this a whitelisted content type? */
export function isAllowedContentType(ct: string): ct is AllowedContentType {
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(ct);
}

/**
 * Build the PutObjectCommand input for a presigned upload. The key is always
 * `${workspaceId}/<random>-<sanitized-filename>` (workspace from context), and
 * the content type must be whitelisted or `ContentTypeError` is thrown.
 */
export function buildPresignRequest(input: PresignRequestInput): PutObjectInput {
  if (!input.workspaceId) {
    throw new Error('buildPresignRequest: workspaceId is required (tenant-isolation guard)');
  }
  if (!isAllowedContentType(input.contentType)) {
    throw new ContentTypeError(input.contentType);
  }
  return {
    Bucket: input.bucket,
    Key: buildImageKey(input.workspaceId, input.filename),
    ContentType: input.contentType,
  };
}
