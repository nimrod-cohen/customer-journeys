import { describe, it, expect } from 'vitest';
import {
  buildImageKey,
  parseWorkspaceFromKey,
  assertKeyInWorkspace,
  KeyScopeError,
} from '../src/key.js';

// §11 / CLAUDE.md invariant: EVERY S3 key is under `${workspace_id}/`. The key
// builder must sanitize the filename so a malicious name (`../`, separators,
// absolute paths) can NEVER escape the workspace prefix, and must be
// collision-resistant. parseWorkspaceFromKey + assertKeyInWorkspace guard the
// service-role variant Lambda (which bypasses RLS) — a key for workspace B must
// be rejected when the caller is scoped to A.

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('buildImageKey', () => {
  it('prefixes the key with `${workspaceId}/`', () => {
    const key = buildImageKey(WS_A, 'logo.png');
    expect(key.startsWith(`${WS_A}/`)).toBe(true);
  });

  it('preserves the file extension', () => {
    expect(buildImageKey(WS_A, 'logo.png')).toMatch(/\.png$/);
    expect(buildImageKey(WS_A, 'hero.JPEG')).toMatch(/\.jpeg$/);
  });

  it('is collision-resistant (same filename → distinct keys)', () => {
    const k1 = buildImageKey(WS_A, 'logo.png');
    const k2 = buildImageKey(WS_A, 'logo.png');
    expect(k1).not.toBe(k2);
  });

  it('sanitizes `..` so the key cannot escape the workspace prefix', () => {
    const key = buildImageKey(WS_A, '../../../etc/passwd');
    expect(key.startsWith(`${WS_A}/`)).toBe(true);
    expect(key).not.toContain('..');
    // The resolved workspace is still A — no traversal.
    expect(parseWorkspaceFromKey(key)).toBe(WS_A);
  });

  it('strips path separators from the filename', () => {
    const key = buildImageKey(WS_A, 'sub/dir\\evil.png');
    expect(key.startsWith(`${WS_A}/`)).toBe(true);
    // Only the single workspace-prefix slash should remain.
    expect(key.split('/').length).toBe(2);
    expect(key).not.toContain('\\');
  });

  it('rejects an empty workspaceId (tenant-isolation guard)', () => {
    expect(() => buildImageKey('', 'logo.png')).toThrow();
  });

  it('falls back to a safe name when the filename is empty/garbage', () => {
    const key = buildImageKey(WS_A, '');
    expect(key.startsWith(`${WS_A}/`)).toBe(true);
    expect(parseWorkspaceFromKey(key)).toBe(WS_A);
  });
});

describe('parseWorkspaceFromKey', () => {
  it('extracts the workspace id from the leading prefix', () => {
    expect(parseWorkspaceFromKey(`${WS_A}/abc-logo.png`)).toBe(WS_A);
  });

  it('throws on a key with no prefix', () => {
    expect(() => parseWorkspaceFromKey('logo.png')).toThrow();
  });
});

describe('assertKeyInWorkspace', () => {
  it('returns the key when it is under the workspace prefix', () => {
    const key = `${WS_A}/abc-logo.png`;
    expect(assertKeyInWorkspace(WS_A, key)).toBe(key);
  });

  it('throws KeyScopeError when a key for B is checked against A (cross-workspace)', () => {
    const keyForB = `${WS_B}/abc-logo.png`;
    expect(() => assertKeyInWorkspace(WS_A, keyForB)).toThrow(KeyScopeError);
  });

  it('throws when the key has no workspace prefix at all', () => {
    expect(() => assertKeyInWorkspace(WS_A, 'logo.png')).toThrow(KeyScopeError);
  });
});
