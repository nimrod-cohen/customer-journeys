// Object-storage helpers (pure): the object key is workspace-prefixed + the
// unguessable uuid; makeR2Storage builds an S3-compatible client (no network on
// construction) exposing put/get/del.
import { describe, it, expect } from 'vitest';
import { makeR2Storage, assetObjectKey } from '../src/storage.js';

describe('object storage helpers', () => {
  it('assetObjectKey is workspace-prefixed', () => {
    expect(assetObjectKey('ws1', 'id1')).toBe('assets/ws1/id1');
  });

  it('makeR2Storage builds a client exposing put/get/del', () => {
    const s = makeR2Storage({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'cdp-assets',
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
    expect(typeof s.put).toBe('function');
    expect(typeof s.get).toBe('function');
    expect(typeof s.del).toBe('function');
  });
});
