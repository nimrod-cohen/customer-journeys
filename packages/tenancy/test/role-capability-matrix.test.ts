import { describe, it, expect } from 'vitest';
import type { Capability, Membership, Role } from '@cdp/shared';
import {
  can,
  resolveRole,
  requireCapability,
  CapabilityError,
} from '../src/index.js';

// AC3 (§3A capability matrix). The exact matrix from the spec:
//
// Capability                     | system-admin | owner | marketer | accounting
// view_all_workspaces            |      ✓       |   –   |    –     |     –
// manage_workspace_users         |      ✓       |   ✓   |    –     |     –
// manage_sending_domain          |      ✓       |   ✓   |    –     |     –
// manage_content                 |      ✓       |   ✓   |    ✓     |     –
// view_billing                   |      ✓       |   ✓   |    –     |     ✓

const ALL: Capability[] = [
  'view_all_workspaces',
  'manage_workspace_users',
  'manage_sending_domain',
  'manage_content',
  'view_billing',
];

const EXPECTED: Record<Role, Capability[]> = {
  'system-admin': [...ALL],
  owner: [
    'manage_workspace_users',
    'manage_sending_domain',
    'manage_content',
    'view_billing',
  ],
  marketer: ['manage_content'],
  accounting: ['view_billing'],
};

describe('can(role, capability) — §3A matrix', () => {
  for (const role of Object.keys(EXPECTED) as Role[]) {
    for (const cap of ALL) {
      const allowed = EXPECTED[role].includes(cap);
      it(`${role} ${allowed ? 'can' : 'cannot'} ${cap}`, () => {
        expect(can(role, cap)).toBe(allowed);
      });
    }
  }

  it('only system-admin crosses tenant boundaries (view_all_workspaces)', () => {
    expect(can('system-admin', 'view_all_workspaces')).toBe(true);
    expect(can('owner', 'view_all_workspaces')).toBe(false);
    expect(can('marketer', 'view_all_workspaces')).toBe(false);
    expect(can('accounting', 'view_all_workspaces')).toBe(false);
  });

  it('marketer cannot manage users/domains/billing', () => {
    expect(can('marketer', 'manage_workspace_users')).toBe(false);
    expect(can('marketer', 'manage_sending_domain')).toBe(false);
    expect(can('marketer', 'view_billing')).toBe(false);
  });

  it('accounting can read billing but cannot edit content', () => {
    expect(can('accounting', 'view_billing')).toBe(true);
    expect(can('accounting', 'manage_content')).toBe(false);
  });
});

describe('resolveRole(memberships, activeWorkspaceId)', () => {
  const memberships: Membership[] = [
    { workspaceId: 'ws-a', role: 'owner' },
    { workspaceId: 'ws-b', role: 'marketer' },
  ];

  it('returns the role for the active workspace', () => {
    expect(resolveRole(memberships, 'ws-a')).toBe('owner');
    expect(resolveRole(memberships, 'ws-b')).toBe('marketer');
  });

  it('returns null when the user has no membership in the active workspace', () => {
    expect(resolveRole(memberships, 'ws-c')).toBeNull();
  });

  it('returns null when activeWorkspaceId is null', () => {
    expect(resolveRole(memberships, null)).toBeNull();
  });
});

describe('requireCapability(ctx, capability)', () => {
  it('passes for an allowed capability', () => {
    expect(() =>
      requireCapability({ role: 'owner', isPlatformAdmin: false }, 'manage_workspace_users'),
    ).not.toThrow();
  });

  it('throws CapabilityError for a forbidden capability', () => {
    expect(() =>
      requireCapability({ role: 'marketer', isPlatformAdmin: false }, 'manage_workspace_users'),
    ).toThrow(CapabilityError);
  });

  it('platform admin passes any capability regardless of workspace role', () => {
    expect(() =>
      requireCapability({ isPlatformAdmin: true }, 'view_all_workspaces'),
    ).not.toThrow();
    expect(() =>
      requireCapability({ isPlatformAdmin: true }, 'manage_content'),
    ).not.toThrow();
  });

  it('throws when there is neither a role nor platform-admin', () => {
    expect(() => requireCapability({ isPlatformAdmin: false }, 'manage_content')).toThrow(
      CapabilityError,
    );
  });
});
