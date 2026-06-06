import { describe, it, expect } from 'vitest';
import { resolveWorkspaceId } from '../src/core.js';
import type { WorkspaceApiKeyRow } from '@cdp/shared';

// AC5 — workspace is derived ONLY from the API key lookup (§7/§13).
// resolveWorkspaceId is the pure mapping: given the api_key_id from the request
// context and the row looked up from workspace_api_keys, return the workspace_id
// or throw if the key is unknown / mismatched.

describe('resolveWorkspaceId (AC5)', () => {
  const row: WorkspaceApiKeyRow = {
    api_key_id: 'key-123',
    workspace_id: 'ws-abc',
    label: 'prod',
  };

  it('returns the workspace_id for a matching key row', () => {
    expect(resolveWorkspaceId('key-123', row)).toBe('ws-abc');
  });

  it('throws when no row was found (unknown key)', () => {
    expect(() => resolveWorkspaceId('key-123', null)).toThrow();
    expect(() => resolveWorkspaceId('key-123', undefined)).toThrow();
  });

  it('throws when the row does not match the requesting key id (defense in depth)', () => {
    const mismatched: WorkspaceApiKeyRow = { ...row, api_key_id: 'other-key' };
    expect(() => resolveWorkspaceId('key-123', mismatched)).toThrow();
  });

  it('throws when the api_key_id from the request context is missing', () => {
    expect(() => resolveWorkspaceId('', row)).toThrow();
    expect(() => resolveWorkspaceId(undefined as unknown as string, row)).toThrow();
  });
});
