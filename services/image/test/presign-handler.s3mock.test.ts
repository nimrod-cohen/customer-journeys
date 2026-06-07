import { describe, it, expect } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { makePresignHandler, type PresignHandlerDeps } from '../src/presign-handler.js';

// §11 / §16A: the presign handler is thin — it pulls workspace from the
// AUTHORIZER CONTEXT (never the body), builds the PutObject input via the pure
// core, and calls getSignedUrl. We mock S3 with aws-sdk-client-mock and stub
// getSignedUrl so no network happens. We assert:
//   - the returned key is under the caller's workspace prefix,
//   - a client-body workspace_id is IGNORED (context wins),
//   - a bad content type → 400,
//   - missing workspace context → 401/403 (not authorized).

const s3mock = mockClient(S3Client);

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVIL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function deps(): PresignHandlerDeps {
  return {
    s3: s3mock as unknown as S3Client,
    // Stub the presigner: echo the command's Key so we can assert on it.
    getSignedUrl: async (_client, command) => {
      const input = (command as PutObjectCommand).input;
      return `https://signed.example/${input.Key}?sig=x`;
    },
    config: {
      bucket: 'cdp-images',
      cloudFrontBaseUrl: 'https://images.cdp.example',
      presignTtlSeconds: 900,
    },
  };
}

function apiEvent(
  body: unknown,
  authorizer: Record<string, unknown> | undefined,
): { body: string; requestContext: { authorizer?: Record<string, unknown> } } {
  return {
    body: JSON.stringify(body),
    requestContext: authorizer ? { authorizer } : {},
  };
}

describe('makePresignHandler', () => {
  it('returns a presigned URL + key under the context workspace prefix', async () => {
    const handler = makePresignHandler(deps());
    const res = await handler(
      apiEvent({ filename: 'logo.png', contentType: 'image/png' }, { workspace_id: WS }),
    );
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body) as { uploadUrl: string; key: string; publicUrl: string };
    expect(out.key.startsWith(`${WS}/`)).toBe(true);
    expect(out.uploadUrl).toContain(out.key);
    expect(out.publicUrl).toBe(`https://images.cdp.example/${out.key}`);
  });

  it('IGNORES a workspace_id in the client body — context workspace wins', async () => {
    const handler = makePresignHandler(deps());
    const res = await handler(
      apiEvent(
        { filename: 'logo.png', contentType: 'image/png', workspace_id: EVIL },
        { workspace_id: WS },
      ),
    );
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body) as { key: string };
    expect(out.key.startsWith(`${WS}/`)).toBe(true);
    expect(out.key).not.toContain(EVIL);
  });

  it('rejects a non-whitelisted content type with 400', async () => {
    const handler = makePresignHandler(deps());
    const res = await handler(
      apiEvent({ filename: 'x.svg', contentType: 'image/svg+xml' }, { workspace_id: WS }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects a request with no workspace context (401)', async () => {
    const handler = makePresignHandler(deps());
    const res = await handler(apiEvent({ filename: 'logo.png', contentType: 'image/png' }, undefined));
    expect(res.statusCode).toBe(401);
  });
});
