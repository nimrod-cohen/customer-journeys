import { describe, it, expect } from 'vitest';
import { buildPresignRequest, ContentTypeError } from '../src/presign.js';

// §11 / CLAUDE.md invariant 2: workspace_id is NEVER taken from the client body.
// buildPresignRequest derives the key prefix from the authorizer-injected
// workspace context, whitelists the content type (png/jpeg/webp/gif only), and
// returns the PutObjectCommand input (Bucket/Key/ContentType) the handler then
// presigns. The result is a pure description — no AWS calls here.

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BUCKET = 'cdp-images';

describe('buildPresignRequest', () => {
  it('puts the object under the context workspace prefix', () => {
    const req = buildPresignRequest({
      bucket: BUCKET,
      workspaceId: WS,
      filename: 'logo.png',
      contentType: 'image/png',
    });
    expect(req.Bucket).toBe(BUCKET);
    expect(req.Key.startsWith(`${WS}/`)).toBe(true);
    expect(req.ContentType).toBe('image/png');
  });

  it('whitelists png/jpeg/webp/gif', () => {
    for (const ct of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(() =>
        buildPresignRequest({ bucket: BUCKET, workspaceId: WS, filename: 'f', contentType: ct }),
      ).not.toThrow();
    }
  });

  it('rejects a non-whitelisted content type', () => {
    expect(() =>
      buildPresignRequest({
        bucket: BUCKET,
        workspaceId: WS,
        filename: 'evil.svg',
        contentType: 'image/svg+xml',
      }),
    ).toThrow(ContentTypeError);
    expect(() =>
      buildPresignRequest({
        bucket: BUCKET,
        workspaceId: WS,
        filename: 'x.exe',
        contentType: 'application/octet-stream',
      }),
    ).toThrow(ContentTypeError);
  });

  it('uses ONLY the workspace from context, never a client-supplied one', () => {
    // A malicious caller passing a different workspace in the filename or body
    // cannot redirect the key — the prefix is always the context workspace.
    const req = buildPresignRequest({
      bucket: BUCKET,
      workspaceId: WS,
      filename: `../${OTHER}/pwn.png`,
      contentType: 'image/png',
    });
    expect(req.Key.startsWith(`${WS}/`)).toBe(true);
    expect(req.Key).not.toContain(OTHER);
  });

  it('requires a workspaceId', () => {
    expect(() =>
      buildPresignRequest({ bucket: BUCKET, workspaceId: '', filename: 'f.png', contentType: 'image/png' }),
    ).toThrow();
  });
});
