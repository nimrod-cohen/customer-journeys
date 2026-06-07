// The workspace-switch store re-scopes by swapping the token (which carries the
// active workspace_id) and reloading /me — with no cross-bleed (§12, §18
// "Multi-workspace switching"). We stub global fetch to simulate the API and
// assert the store flips workspace + role, and that the new token is what's used
// for the subsequent /me call.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sessionStore, switchWorkspace, login, effectiveRole, logout } from '../src/store/session.js';

const realFetch = globalThis.fetch;

function routeFetch(handlers: Record<string, (init?: RequestInit) => unknown>) {
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const h = handlers[path];
    if (!h) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(h(init)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('workspace-switch store', () => {
  beforeEach(() => logout());
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('effectiveRole maps platform-admin to system-admin, else the workspace role', () => {
    expect(effectiveRole('marketer', false)).toBe('marketer');
    expect(effectiveRole('marketer', true)).toBe('system-admin');
    expect(effectiveRole(null, true)).toBe('system-admin');
    expect(effectiveRole(null, false)).toBeNull();
  });

  it('login then switch flips active workspace + role and uses the NEW token for /me', () => {
    const tokensSeen: string[] = [];
    let meWorkspace = 'WS_A';
    let meRole: string | null = 'owner';
    routeFetch({
      '/auth/dev-login': () => ({
        token: 'tok-A',
        sub: 'u1',
        workspace_id: 'WS_A',
        is_platform_admin: false,
        memberships: [
          { workspaceId: 'WS_A', role: 'owner' },
          { workspaceId: 'WS_B', role: 'marketer' },
        ],
      }),
      '/me': (init) => {
        tokensSeen.push((init?.headers as Record<string, string>)?.authorization ?? '');
        return {
          sub: 'u1',
          workspace_id: meWorkspace,
          role: meRole,
          is_platform_admin: false,
          memberships: [
            { workspaceId: 'WS_A', role: 'owner' },
            { workspaceId: 'WS_B', role: 'marketer' },
          ],
        };
      },
      '/workspace/switch': () => {
        meWorkspace = 'WS_B';
        meRole = 'marketer';
        return { token: 'tok-B', workspace_id: 'WS_B', role: 'marketer', is_platform_admin: false };
      },
    });

    return (async () => {
      await login('u1@dev.local', 'pw');
      expect(sessionStore.get().workspaceId).toBe('WS_A');
      expect(sessionStore.get().role).toBe('owner');

      await switchWorkspace('WS_B');
      expect(sessionStore.get().workspaceId).toBe('WS_B');
      expect(sessionStore.get().role).toBe('marketer');
      // The /me after the switch must use the NEW token (tok-B), proving re-scope.
      expect(tokensSeen[tokensSeen.length - 1]).toBe('Bearer tok-B');
    })();
  });

  it('logout clears the session', async () => {
    routeFetch({
      '/auth/dev-login': () => ({
        token: 't',
        sub: 'u1',
        workspace_id: 'WS_A',
        is_platform_admin: false,
        memberships: [{ workspaceId: 'WS_A', role: 'owner' }],
      }),
      '/me': () => ({
        sub: 'u1',
        workspace_id: 'WS_A',
        role: 'owner',
        is_platform_admin: false,
        memberships: [],
      }),
    });
    await login('u1@dev.local', 'pw');
    expect(sessionStore.get().token).not.toBeNull();
    logout();
    expect(sessionStore.get().token).toBeNull();
    expect(sessionStore.get().workspaceId).toBeNull();
  });
});
