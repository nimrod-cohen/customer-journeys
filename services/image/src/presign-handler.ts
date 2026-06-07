// Presign handler (§11) — thin. It wires the pure presign core to S3 +
// s3-request-presigner. The workspace is read from the AUTHORIZER CONTEXT
// (requestContext.authorizer.workspace_id), NEVER from the request body
// (CLAUDE.md invariant 2). All logic (key building, content-type whitelist)
// lives in ./presign.ts; this only does request parsing, signing, and response
// mapping.
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { buildPresignRequest, ContentTypeError } from './presign.js';
import type { ImageConfig } from './deps.js';

/** The presigner function shape (s3-request-presigner getSignedUrl). */
export type GetSignedUrl = (
  client: S3Client,
  command: PutObjectCommand,
  options?: { expiresIn?: number },
) => Promise<string>;

/** Injected deps for the presign handler. */
export interface PresignHandlerDeps {
  readonly s3: S3Client;
  readonly getSignedUrl: GetSignedUrl;
  readonly config: ImageConfig;
}

/** Minimal API Gateway proxy event shape we read. */
export interface PresignEvent {
  readonly body?: string | null;
  readonly requestContext?: {
    readonly authorizer?: Record<string, unknown> | null;
  };
}

export interface HandlerResult {
  readonly statusCode: number;
  readonly body: string;
}

function json(statusCode: number, payload: unknown): HandlerResult {
  return { statusCode, body: JSON.stringify(payload) };
}

/** Build the presign handler from injected deps. */
export function makePresignHandler(deps: PresignHandlerDeps) {
  return async function handler(event: PresignEvent): Promise<HandlerResult> {
    // Workspace from the authorizer context ONLY (never the body, §13).
    const workspaceId = event.requestContext?.authorizer?.['workspace_id'];
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return json(401, { error: 'unauthorized: no workspace context' });
    }

    let body: { filename?: unknown; contentType?: unknown };
    try {
      body = event.body ? (JSON.parse(event.body) as typeof body) : {};
    } catch {
      return json(400, { error: 'invalid JSON body' });
    }
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const contentType = typeof body.contentType === 'string' ? body.contentType : '';

    let putInput;
    try {
      putInput = buildPresignRequest({
        bucket: deps.config.bucket,
        workspaceId, // from context — a body workspace_id is never consulted
        filename,
        contentType,
      });
    } catch (err) {
      if (err instanceof ContentTypeError) return json(400, { error: err.message });
      return json(400, { error: 'invalid presign request' });
    }

    const command = new PutObjectCommand(putInput);
    const uploadUrl = await deps.getSignedUrl(deps.s3, command, {
      expiresIn: deps.config.presignTtlSeconds,
    });

    return json(200, {
      uploadUrl,
      key: putInput.Key,
      publicUrl: `${deps.config.cloudFrontBaseUrl}/${putInput.Key}`,
    });
  };
}
