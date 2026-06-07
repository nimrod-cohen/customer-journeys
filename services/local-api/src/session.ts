// Dev session endpoints (§12): POST /auth/dev-login and POST /workspace/switch.
// These sit OUTSIDE the capability-enforced route table: dev-login is pre-auth
// (it mints the first token); switch only needs a valid token + membership (or
// platform-admin) and re-issues a token with the new active workspace_id —
// reusing @cdp/tenancy switchActiveWorkspace so the cross-tenant rule is shared.
import { switchActiveWorkspace } from '@cdp/tenancy';
import type { Membership } from '@cdp/shared';
import { encodeDevToken, decodeDevToken, extractBearer } from './auth.js';
import type { AuthorizerLookups } from './auth.js';

/** Response for dev-login / switch — a bearer token + the resolved session. */
export interface SessionResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * POST /auth/dev-login — resolve a user's memberships and mint a dev token whose
 * active workspace_id defaults to the FIRST membership (or a body-provided
 * workspace_id IF the user is a member / platform admin). The user id is supplied
 * by the caller (a real Supabase login would supply `sub`); for local/e2e this is
 * a seeded user id. workspace_id in the TOKEN is authoritative thereafter.
 */
export async function devLogin(
  lookups: AuthorizerLookups,
  body: unknown,
): Promise<SessionResult> {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const sub = String(b.user_id ?? b.sub ?? '');
  if (!sub) return { status: 400, body: { error: 'user_id (sub) required' } };

  const [memberships, isPlatformAdmin] = await Promise.all([
    lookups.loadMemberships(sub),
    lookups.loadIsPlatformAdmin(sub),
  ]);

  // Choose the active workspace: a requested one (must be valid), else the first
  // membership, else null (platform admins may have none).
  const requested = typeof b.workspace_id === 'string' ? b.workspace_id : null;
  let active: string | null = null;
  if (requested) {
    const allowed =
      isPlatformAdmin || memberships.some((m: Membership) => m.workspaceId === requested);
    if (!allowed) {
      return { status: 403, body: { error: 'not a member of requested workspace' } };
    }
    active = requested;
  } else {
    active = memberships[0]?.workspaceId ?? null;
  }

  const token = encodeDevToken({ sub, workspace_id: active });
  return {
    status: 200,
    body: {
      token,
      sub,
      workspace_id: active,
      is_platform_admin: isPlatformAdmin,
      memberships,
    },
  };
}

/**
 * POST /workspace/switch — re-issue a token with a new active workspace_id.
 * Reuses tenancy.switchActiveWorkspace so the membership/platform-admin rule is
 * the single source of truth: a normal user can only switch to a workspace they
 * belong to; a platform admin may switch to ANY (the audited cross-tenant break).
 */
export async function switchWorkspace(
  lookups: AuthorizerLookups,
  authorization: string | null,
  body: unknown,
): Promise<SessionResult> {
  const bearer = extractBearer(authorization);
  const jwt = bearer ? decodeDevToken(bearer) : null;
  if (!jwt) return { status: 401, body: { error: 'invalid token' } };

  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const target = String(b.workspace_id ?? '');
  if (!target) return { status: 400, body: { error: 'workspace_id required' } };

  const [memberships, isPlatformAdmin] = await Promise.all([
    lookups.loadMemberships(jwt.sub),
    lookups.loadIsPlatformAdmin(jwt.sub),
  ]);

  try {
    const wsCtx = switchActiveWorkspace(memberships, target, isPlatformAdmin);
    const token = encodeDevToken({ sub: jwt.sub, workspace_id: wsCtx.workspaceId });
    return {
      status: 200,
      body: {
        token,
        sub: jwt.sub,
        workspace_id: wsCtx.workspaceId,
        role: wsCtx.role ?? null,
        is_platform_admin: isPlatformAdmin,
      },
    };
  } catch {
    return { status: 403, body: { error: 'cannot switch to that workspace' } };
  }
}
