import { describe, it, expect, vi } from 'vitest';
import {
  contextFromAuthorizer,
  enforceRoute,
  RouteForbiddenError,
} from '../src/middleware.js';
import type { Capability } from '@cdp/shared';

// AC3 — route role-enforcement (§3A, §12, §13). The API reads the authoritative
// identity from the AUTHORIZER-injected request context (string values), never
// from the client body, then enforces the route's required capability.

function reqCtx(authorizer: Record<string, string | undefined>) {
  return { requestContext: { authorizer } };
}

describe('contextFromAuthorizer', () => {
  it('parses the authorizer string context into a typed WorkspaceContext', () => {
    const ctx = contextFromAuthorizer(
      reqCtx({ sub: 'u1', workspace_id: 'ws-a', role: 'owner', is_platform_admin: 'false' }),
    );
    expect(ctx.workspaceId).toBe('ws-a');
    expect(ctx.userId).toBe('u1');
    expect(ctx.role).toBe('owner');
    expect(ctx.isPlatformAdmin).toBe(false);
  });

  it('parses is_platform_admin=true', () => {
    const ctx = contextFromAuthorizer(
      reqCtx({ sub: 'admin', workspace_id: 'ws-z', is_platform_admin: 'true' }),
    );
    expect(ctx.isPlatformAdmin).toBe(true);
    expect(ctx.role).toBeUndefined();
  });

  it('throws if the authorizer context is missing (defense in depth)', () => {
    expect(() => contextFromAuthorizer({ requestContext: {} })).toThrow();
  });
});

describe('enforceRoute(ctx, capability)', () => {
  const cases: Array<{ role: string; cap: Capability; ok: boolean }> = [
    { role: 'marketer', cap: 'manage_content', ok: true },
    { role: 'marketer', cap: 'manage_workspace_users', ok: false },
    { role: 'marketer', cap: 'view_billing', ok: false },
    { role: 'accounting', cap: 'view_billing', ok: true },
    { role: 'accounting', cap: 'manage_content', ok: false },
    { role: 'owner', cap: 'manage_workspace_users', ok: true },
    { role: 'owner', cap: 'manage_content', ok: true },
  ];
  for (const { role, cap, ok } of cases) {
    it(`${role} ${ok ? 'passes' : 'is forbidden for'} ${cap}`, () => {
      const ctx = contextFromAuthorizer(
        reqCtx({ sub: 'u', workspace_id: 'ws-a', role, is_platform_admin: 'false' }),
      );
      if (ok) expect(() => enforceRoute(ctx, cap)).not.toThrow();
      else expect(() => enforceRoute(ctx, cap)).toThrow(RouteForbiddenError);
    });
  }

  it('system-admin passes the cross-tenant capability', () => {
    const ctx = contextFromAuthorizer(
      reqCtx({ sub: 'admin', workspace_id: 'ws-z', is_platform_admin: 'true' }),
    );
    expect(() => enforceRoute(ctx, 'view_all_workspaces')).not.toThrow();
  });
});

describe('cross-tenant system-admin access is audited', () => {
  it('writes an admin_audit_log entry when a platform admin reads another workspace', async () => {
    const { handleAdminAccess } = await import('../src/middleware.js');
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    const ctx = contextFromAuthorizer(
      reqCtx({ sub: 'admin-1', workspace_id: 'ws-a', is_platform_admin: 'true' }),
    );
    await handleAdminAccess(ctx, 'ws-b', 'read_profiles', { count: 2 }, writeAudit);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'admin-1',
        workspace_id: 'ws-b',
        action: 'read_profiles',
        detail: { count: 2 },
      }),
    );
  });

  it('does NOT audit when the admin acts within their active workspace', async () => {
    const { handleAdminAccess } = await import('../src/middleware.js');
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    const ctx = contextFromAuthorizer(
      reqCtx({ sub: 'admin-1', workspace_id: 'ws-a', is_platform_admin: 'true' }),
    );
    await handleAdminAccess(ctx, 'ws-a', 'read_profiles', {}, writeAudit);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('does NOT audit a normal user (they cannot cross tenants anyway)', async () => {
    const { handleAdminAccess } = await import('../src/middleware.js');
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    const ctx = contextFromAuthorizer(
      reqCtx({ sub: 'u', workspace_id: 'ws-a', role: 'owner', is_platform_admin: 'false' }),
    );
    await handleAdminAccess(ctx, 'ws-b', 'read_profiles', {}, writeAudit);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
