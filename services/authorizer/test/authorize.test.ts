import { describe, it, expect } from 'vitest';
import type { Membership } from '@cdp/shared';
import { authorize, buildAuthorizerPolicy } from '../src/authorize.js';
import type { DecodedJwt } from '../src/authorize.js';

// AC3/AC4/AC5 core: the pure authorization function. JWKS verification is done
// by the handler and INJECTED here as an already-decoded, already-verified JWT.

const baseJwt: DecodedJwt = {
  sub: 'user-1',
  workspace_id: 'ws-a',
};

const memberships: Membership[] = [
  { workspaceId: 'ws-a', role: 'owner' },
  { workspaceId: 'ws-b', role: 'marketer' },
];

describe('authorize(decodedJwt, membership, isPlatformAdmin)', () => {
  it('allows a member acting in their active workspace and injects claims', () => {
    const r = authorize(baseJwt, memberships, false);
    expect(r.allowed).toBe(true);
    expect(r.principalId).toBe('user-1');
    expect(r.claims?.workspace_id).toBe('ws-a');
    expect(r.claims?.role).toBe('owner');
    expect(r.claims?.is_platform_admin).toBe(false);
    expect(r.effectiveRole).toBe('owner');
  });

  it('resolves the role for whichever active workspace the JWT names (switch)', () => {
    const r = authorize({ ...baseJwt, workspace_id: 'ws-b' }, memberships, false);
    expect(r.allowed).toBe(true);
    expect(r.claims?.workspace_id).toBe('ws-b');
    expect(r.effectiveRole).toBe('marketer');
  });

  it('DENIES when the active workspace claim is not one of the memberships', () => {
    // AC1/AC5: a client cannot point its active claim at a foreign workspace.
    const r = authorize({ ...baseJwt, workspace_id: 'ws-c' }, memberships, false);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/membership/i);
  });

  it('DENIES when there is no active workspace and not a platform admin', () => {
    const r = authorize({ sub: 'user-1', workspace_id: null }, memberships, false);
    expect(r.allowed).toBe(false);
  });

  it('allows a platform admin into ANY workspace and sets is_platform_admin', () => {
    // AC4: cross-tenant role. workspace_id may be a workspace they are not a member of.
    const r = authorize({ sub: 'admin-1', workspace_id: 'ws-z' }, [], true);
    expect(r.allowed).toBe(true);
    expect(r.claims?.is_platform_admin).toBe(true);
    expect(r.claims?.workspace_id).toBe('ws-z');
    expect(r.effectiveRole).toBe('system-admin');
  });

  it('a platform admin who is also a member keeps their workspace role too', () => {
    const r = authorize({ sub: 'admin-1', workspace_id: 'ws-a' }, memberships, true);
    expect(r.allowed).toBe(true);
    expect(r.claims?.is_platform_admin).toBe(true);
    // effective role for capability checks is system-admin (superset)
    expect(r.effectiveRole).toBe('system-admin');
    expect(r.claims?.role).toBe('owner');
  });

  it('DENIES a JWT with no sub', () => {
    const r = authorize({ sub: '', workspace_id: 'ws-a' }, memberships, false);
    expect(r.allowed).toBe(false);
  });
});

describe('buildAuthorizerPolicy(authResult)', () => {
  it('builds an Allow policy with injected claim context when allowed', () => {
    const r = authorize(baseJwt, memberships, false);
    const policy = buildAuthorizerPolicy(r);
    expect(policy.principalId).toBe('user-1');
    expect(policy.policyDocument.Statement[0]?.Effect).toBe('Allow');
    // claims are stringified into the context (API GW only allows string values)
    expect(policy.context.workspace_id).toBe('ws-a');
    expect(policy.context.is_platform_admin).toBe('false');
    expect(policy.context.role).toBe('owner');
    expect(policy.context.sub).toBe('user-1');
  });

  it('builds a Deny policy when not allowed', () => {
    const r = authorize({ ...baseJwt, workspace_id: 'ws-c' }, memberships, false);
    const policy = buildAuthorizerPolicy(r);
    expect(policy.policyDocument.Statement[0]?.Effect).toBe('Deny');
    expect(policy.principalId).toBe('user');
  });

  it('serializes context values as strings only (API GW constraint)', () => {
    const r = authorize({ sub: 'admin-1', workspace_id: 'ws-z' }, [], true);
    const policy = buildAuthorizerPolicy(r);
    for (const v of Object.values(policy.context)) {
      expect(typeof v).toBe('string');
    }
  });
});
