import { describe, it, expect, vi } from 'vitest';
import { makeAuthorizerHandler } from '../src/handler.js';
import type { Membership } from '@cdp/shared';

// Thin-handler delegation: the handler verifies the JWT via an injected verifier
// (real impl = jose against Supabase JWKS), looks up membership + platform-admin
// via injected loaders, then delegates to the pure authorize() core and returns
// an API Gateway policy. No DB/JWKS here — both are injected and mocked.

function makeEvent(token: string | undefined) {
  return {
    type: 'TOKEN' as const,
    methodArn: 'arn:aws:execute-api:us-east-1:123:abc/prod/GET/things',
    authorizationToken: token ? `Bearer ${token}` : '',
  };
}

const memberships: Membership[] = [{ workspaceId: 'ws-a', role: 'owner' }];

describe('makeAuthorizerHandler — delegation', () => {
  it('verifies token, loads membership/admin, and returns an Allow policy', async () => {
    const verifyJwt = vi.fn().mockResolvedValue({ sub: 'user-1', workspace_id: 'ws-a' });
    const loadMemberships = vi.fn().mockResolvedValue(memberships);
    const loadIsPlatformAdmin = vi.fn().mockResolvedValue(false);

    const handler = makeAuthorizerHandler({ verifyJwt, loadMemberships, loadIsPlatformAdmin });
    const res = await handler(makeEvent('tok'));

    expect(verifyJwt).toHaveBeenCalledWith('tok');
    expect(loadMemberships).toHaveBeenCalledWith('user-1');
    expect(loadIsPlatformAdmin).toHaveBeenCalledWith('user-1');
    expect(res.policyDocument.Statement[0]?.Effect).toBe('Allow');
    expect(res.context.workspace_id).toBe('ws-a');
  });

  it('denies (throws Unauthorized) when the token is missing', async () => {
    const handler = makeAuthorizerHandler({
      verifyJwt: vi.fn(),
      loadMemberships: vi.fn(),
      loadIsPlatformAdmin: vi.fn(),
    });
    await expect(handler(makeEvent(undefined))).rejects.toThrow(/Unauthorized/);
  });

  it('denies when JWT verification fails (invalid signature/expired)', async () => {
    const verifyJwt = vi.fn().mockRejectedValue(new Error('bad signature'));
    const handler = makeAuthorizerHandler({
      verifyJwt,
      loadMemberships: vi.fn(),
      loadIsPlatformAdmin: vi.fn(),
    });
    await expect(handler(makeEvent('tok'))).rejects.toThrow(/Unauthorized/);
  });

  it('returns a Deny policy when the active workspace is not a membership', async () => {
    const verifyJwt = vi.fn().mockResolvedValue({ sub: 'user-1', workspace_id: 'ws-OTHER' });
    const handler = makeAuthorizerHandler({
      verifyJwt,
      loadMemberships: vi.fn().mockResolvedValue(memberships),
      loadIsPlatformAdmin: vi.fn().mockResolvedValue(false),
    });
    const res = await handler(makeEvent('tok'));
    expect(res.policyDocument.Statement[0]?.Effect).toBe('Deny');
  });

  it('allows a platform admin into a non-member workspace', async () => {
    const verifyJwt = vi.fn().mockResolvedValue({ sub: 'admin-1', workspace_id: 'ws-z' });
    const handler = makeAuthorizerHandler({
      verifyJwt,
      loadMemberships: vi.fn().mockResolvedValue([]),
      loadIsPlatformAdmin: vi.fn().mockResolvedValue(true),
    });
    const res = await handler(makeEvent('tok'));
    expect(res.policyDocument.Statement[0]?.Effect).toBe('Allow');
    expect(res.context.is_platform_admin).toBe('true');
  });
});
