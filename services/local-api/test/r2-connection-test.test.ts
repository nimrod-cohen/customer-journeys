// "Test connection" on the Storage screen.
//
// The point is to fail BEFORE someone's first image upload does, and to say which
// part is wrong. An S3 error name alone is useless to the person reading it —
// `AccessDenied` on a bucket that exists means a token scoped to a DIFFERENT
// bucket, which is exactly the misconfiguration that would otherwise surface much
// later as a 500 on upload.
import { describe, it, expect } from 'vitest';
import { explainStorageError } from '../src/storage.js';

describe('explainStorageError', () => {
  // R2 answers a token scoped elsewhere with 403 for EVERY bucket, existing or not —
  // it will not even admit whether the bucket is there.
  it('reads a 403 as a scope problem, naming the bucket', () => {
    const e = explainStorageError({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'acme-bucket');
    expect(e).toMatch(/acme-bucket/);
    expect(e).toMatch(/scoped|permission/i);
  });

  it('reads a missing bucket as a missing bucket', () => {
    expect(explainStorageError({ name: 'NoSuchBucket' }, 'acme-bucket')).toMatch(/does not exist/i);
  });

  it('separates a wrong key id from a wrong secret', () => {
    expect(explainStorageError({ name: 'InvalidAccessKeyId' }, 'b')).toMatch(/access key id/i);
    expect(explainStorageError({ name: 'SignatureDoesNotMatch' }, 'b')).toMatch(/secret/i);
  });

  // A typo'd account id gives a hostname that does not resolve.
  it('reads a DNS or connection failure as an endpoint problem', () => {
    expect(explainStorageError({ code: 'ENOTFOUND' }, 'b')).toMatch(/endpoint/i);
    expect(explainStorageError({ name: 'TimeoutError' }, 'b')).toMatch(/endpoint|reach/i);
  });

  // Never swallow the original: an unrecognised failure must still say something.
  it('falls back to the provider’s own message', () => {
    expect(explainStorageError(new Error('some novel failure'), 'b')).toMatch(/some novel failure/);
    expect(explainStorageError(null, 'b')).toBeTruthy();
  });
});
