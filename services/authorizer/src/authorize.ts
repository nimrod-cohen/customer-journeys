// Pure authorization core for the Lambda authorizer (§12, §3A).
//
// JWKS verification (jose) and DB lookups are NOT done here — they are performed
// by the thin handler and their already-resolved outputs (a verified decoded JWT,
// the user's memberships, and platform-admin status) are passed in. This keeps
// the authorization decision a pure, fully unit-testable function.
import type { AuthResult, CompanyMembership, Membership, Role } from '@cdp/shared';
import { resolveRole, buildJwtClaims } from '@cdp/tenancy';

/** The subset of verified Supabase JWT claims the authorizer needs (§12). */
export interface DecodedJwt {
  /** Supabase auth user id. */
  readonly sub: string;
  /** The active workspace id claim (set by the login flow / switcher). */
  readonly workspace_id: string | null;
}

/**
 * Decide whether a request is allowed and what claims to inject (§12, §3A).
 *
 * Company-centric RBAC: the user's ROLE is their COMPANY role (from `company_users`,
 * passed as `company`). `memberships` are the workspaces the user may ACT in
 * (owner→all company workspaces, marketer→granted, accounting→none).
 *
 * Rules:
 *  - The token must carry a `sub`.
 *  - When an active `workspace_id` is present it MUST be one of the accessible
 *    `memberships` — a client cannot point the active claim at a foreign workspace.
 *  - A company role with NO active workspace is allowed as a COMPANY-LEVEL context
 *    (e.g. accounting → billing); workspace-scoped routes are gated downstream.
 *  - A platform admin may target ANY workspace (cross-tenant break, §3A) and is
 *    given the `system-admin` effective role.
 *  - `company` omitted/null falls back to the legacy per-workspace resolution.
 */
export function authorize(
  jwt: DecodedJwt,
  memberships: readonly Membership[],
  isPlatformAdmin: boolean,
  company?: CompanyMembership | null,
): AuthResult {
  if (!jwt.sub) {
    return { allowed: false, reason: 'missing sub claim' };
  }

  const activeWorkspaceId = jwt.workspace_id;
  // The COMPANY role is authoritative; fall back to the workspace role only when no
  // company context was supplied (legacy callers / un-migrated data).
  const companyRole = company?.role ?? null;
  const role = companyRole ?? resolveRole(memberships, activeWorkspaceId);

  if (!isPlatformAdmin) {
    if (activeWorkspaceId) {
      // An active workspace must be one the user can access.
      if (role === null || !memberships.some((m) => m.workspaceId === activeWorkspaceId)) {
        return {
          allowed: false,
          principalId: jwt.sub,
          reason: 'active workspace is not one of the user memberships',
        };
      }
    } else if (companyRole === null) {
      // No active workspace AND no company role → nothing to scope to.
      return { allowed: false, principalId: jwt.sub, reason: 'no active workspace' };
    }
    // else: a company role with no active workspace → company-level context (allowed).
  }

  const claims = buildJwtClaims({
    workspaceId: activeWorkspaceId ?? '',
    userId: jwt.sub,
    isPlatformAdmin,
    ...(company?.companyId ? { companyId: company.companyId } : {}),
    ...(role !== null ? { role } : {}),
  });

  const effectiveRole: Role = isPlatformAdmin ? 'system-admin' : (role as Role);

  return {
    allowed: true,
    principalId: jwt.sub,
    claims,
    effectiveRole,
  };
}

/** API Gateway authorizer policy shape (REST API, custom authorizer). */
export interface AuthorizerPolicy {
  readonly principalId: string;
  readonly policyDocument: {
    readonly Version: '2012-10-17';
    readonly Statement: ReadonlyArray<{
      readonly Action: string;
      readonly Effect: 'Allow' | 'Deny';
      readonly Resource: string;
    }>;
  };
  /** API GW context values must be strings/numbers/booleans → serialized to strings. */
  readonly context: Record<string, string>;
}

/**
 * Turn an AuthResult into an API Gateway authorizer policy. On allow, the claim
 * set is flattened into the request context (string values only) so downstream
 * API Lambdas read the authoritative `workspace_id`/role/is_platform_admin from
 * the authorizer — never from the client body (§13).
 */
export function buildAuthorizerPolicy(
  result: AuthResult,
  resource = '*',
): AuthorizerPolicy {
  const effect: 'Allow' | 'Deny' = result.allowed ? 'Allow' : 'Deny';
  const context: Record<string, string> = {};

  if (result.allowed && result.claims) {
    context.sub = result.claims.sub;
    context.workspace_id = result.claims.workspace_id ?? '';
    context.is_platform_admin = String(result.claims.is_platform_admin);
    if (result.claims.company_id) context.company_id = result.claims.company_id;
    if (result.claims.role !== undefined) context.role = result.claims.role;
    if (result.effectiveRole !== undefined) context.effective_role = result.effectiveRole;
  }

  return {
    principalId: result.allowed ? (result.principalId ?? 'user') : 'user',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
    },
    context,
  };
}
