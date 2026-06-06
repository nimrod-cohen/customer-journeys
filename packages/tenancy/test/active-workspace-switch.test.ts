import { describe, it, expect } from 'vitest';
import type { Membership } from '@cdp/shared';
import {
  switchActiveWorkspace,
  buildJwtClaims,
  isCrossTenantAccess,
  recordCrossTenantAccess,
} from '../src/index.js';

// AC5 (§12 multi-workspace switching) + AC4 (§3A cross-tenant audit, pure parts).

const memberships: Membership[] = [
  { workspaceId: 'ws-a', role: 'owner' },
  { workspaceId: 'ws-b', role: 'marketer' },
];

describe('switchActiveWorkspace(memberships, target, isPlatformAdmin)', () => {
  it('switches to a workspace the user is a member of', () => {
    const ctx = switchActiveWorkspace(memberships, 'ws-b', false);
    expect(ctx.workspaceId).toBe('ws-b');
    expect(ctx.role).toBe('marketer');
    expect(ctx.isPlatformAdmin).toBe(false);
  });

  it('rejects switching to a workspace the user does not belong to', () => {
    expect(() => switchActiveWorkspace(memberships, 'ws-c', false)).toThrow();
  });

  it('platform admin may switch to ANY workspace (cross-tenant)', () => {
    const ctx = switchActiveWorkspace([], 'ws-zzz', true);
    expect(ctx.workspaceId).toBe('ws-zzz');
    expect(ctx.isPlatformAdmin).toBe(true);
    // platform admin has no workspace role unless they are also a member
    expect(ctx.role).toBeUndefined();
  });

  it('platform admin who is also a member keeps the member role', () => {
    const ctx = switchActiveWorkspace(memberships, 'ws-a', true);
    expect(ctx.workspaceId).toBe('ws-a');
    expect(ctx.role).toBe('owner');
    expect(ctx.isPlatformAdmin).toBe(true);
  });
});

describe('buildJwtClaims(ctx)', () => {
  it('emits the active workspace_id, sub, role, and is_platform_admin claims', () => {
    const claims = buildJwtClaims({
      workspaceId: 'ws-a',
      userId: 'user-1',
      role: 'owner',
      isPlatformAdmin: false,
    });
    expect(claims.workspace_id).toBe('ws-a');
    expect(claims.sub).toBe('user-1');
    expect(claims.role).toBe('owner');
    expect(claims.is_platform_admin).toBe(false);
  });

  it('omits role for a platform-admin-only context', () => {
    const claims = buildJwtClaims({
      workspaceId: 'ws-x',
      userId: 'admin-1',
      isPlatformAdmin: true,
    });
    expect(claims.role).toBeUndefined();
    expect(claims.is_platform_admin).toBe(true);
    expect(claims.workspace_id).toBe('ws-x');
  });
});

describe('isCrossTenantAccess(ctx, target)', () => {
  it('is false when the target equals the active workspace', () => {
    expect(
      isCrossTenantAccess(
        { workspaceId: 'ws-a', isPlatformAdmin: true },
        'ws-a',
      ),
    ).toBe(false);
  });

  it('is true when a platform admin reaches into a different workspace', () => {
    expect(
      isCrossTenantAccess(
        { workspaceId: 'ws-a', isPlatformAdmin: true },
        'ws-b',
      ),
    ).toBe(true);
  });

  it('is false for a non-admin (they can never reach another workspace anyway)', () => {
    expect(
      isCrossTenantAccess(
        { workspaceId: 'ws-a', isPlatformAdmin: false },
        'ws-b',
      ),
    ).toBe(false);
  });
});

describe('recordCrossTenantAccess(userId, workspaceId, action, detail)', () => {
  it('produces a well-formed admin_audit_log entry', () => {
    const entry = recordCrossTenantAccess('admin-1', 'ws-b', 'read_profiles', {
      count: 3,
    });
    expect(entry.user_id).toBe('admin-1');
    expect(entry.workspace_id).toBe('ws-b');
    expect(entry.action).toBe('read_profiles');
    expect(entry.detail).toEqual({ count: 3 });
  });

  it('allows a null workspace_id (account-level action)', () => {
    const entry = recordCrossTenantAccess('admin-1', null, 'list_workspaces');
    expect(entry.workspace_id).toBeNull();
    expect(entry.action).toBe('list_workspaces');
    expect(entry.detail).toBeUndefined();
  });
});
