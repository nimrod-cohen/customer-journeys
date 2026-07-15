// Object-storage config (pure): r2StorageFromEnv is null unless EVERY R2 var is
// present; publicUrl formats against the (trailing-slash-trimmed) public base;
// the object key is workspace-prefixed + unguessable.
import { describe, it, expect } from 'vitest';
import { r2StorageFromEnv, assetObjectKey } from '../src/storage.js';

describe('object storage config', () => {
  it('returns null when any R2 env var is missing', () => {
    expect(r2StorageFromEnv({})).toBeNull();
    // present but no public base → still null
    expect(
      r2StorageFromEnv({ R2_ENDPOINT: 'x', R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' }),
    ).toBeNull();
  });

  it('builds a client + formats the public URL (trailing slash trimmed) when fully configured', () => {
    const s = r2StorageFromEnv({
      R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      R2_BUCKET: 'cdp-assets',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_PUBLIC_BASE_URL: 'https://assets.on-grow.com/',
    });
    expect(s).not.toBeNull();
    expect(s!.publicUrl('assets/ws/id')).toBe('https://assets.on-grow.com/assets/ws/id');
  });

  it('assetObjectKey is workspace-prefixed', () => {
    expect(assetObjectKey('ws1', 'id1')).toBe('assets/ws1/id1');
  });
});
