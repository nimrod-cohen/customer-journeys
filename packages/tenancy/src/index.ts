// @cdp/tenancy — workspace context helpers + role/capability checks (§3A, §12, §13).
//
// All logic here is PURE (no DB, no AWS) so it is unit-testable in isolation and
// reusable by the authorizer (claim building) and the API (capability enforcement).
import type {
  Capability,
  ClaimSet,
  Membership,
  Role,
  WorkspaceContext,
  WorkspaceRole,
} from '@cdp/shared';

export type {
  Capability,
  ClaimSet,
  Membership,
  Role,
  WorkspaceContext,
  WorkspaceRole,
} from '@cdp/shared';

/**
 * The §3A capability matrix, encoded once as the single source of truth.
 * Workspace roles are additive within their workspace; `system-admin` (the only
 * cross-tenant role) gets everything.
 */
const CAPABILITY_MATRIX: Record<Role, ReadonlySet<Capability>> = {
  'system-admin': new Set<Capability>([
    'view_all_workspaces',
    'manage_workspace_users',
    'manage_sending_domain',
    'manage_content',
    'view_billing',
  ]),
  owner: new Set<Capability>([
    'manage_workspace_users',
    'manage_sending_domain',
    'manage_content',
    'view_billing',
  ]),
  marketer: new Set<Capability>(['manage_content']),
  accounting: new Set<Capability>(['view_billing']),
};

/** Pure capability check against the §3A matrix. */
export function can(role: Role, capability: Capability): boolean {
  return CAPABILITY_MATRIX[role]?.has(capability) ?? false;
}

/**
 * Resolve the effective workspace role for the active workspace from the user's
 * memberships. Returns null when the user is not a member of that workspace
 * (or no workspace is active). Note: platform-admin status is handled separately
 * — a platform admin may have no membership row yet still be authorized (§3A).
 */
export function resolveRole(
  memberships: readonly Membership[],
  activeWorkspaceId: string | null,
): WorkspaceRole | null {
  if (!activeWorkspaceId) return null;
  const m = memberships.find((x) => x.workspaceId === activeWorkspaceId);
  return m ? m.role : null;
}

/** A minimal capability context: either a workspace role, platform-admin, or both. */
export interface CapabilityContext {
  readonly role?: WorkspaceRole;
  readonly isPlatformAdmin: boolean;
}

/** Thrown when a capability check fails (HTTP 403 at the API edge). */
export class CapabilityError extends Error {
  readonly capability: Capability;
  constructor(capability: Capability) {
    super(`Missing capability: ${capability}`);
    this.name = 'CapabilityError';
    this.capability = capability;
  }
}

/**
 * Enforce that the context may perform `capability`, throwing CapabilityError
 * otherwise. Platform admins are evaluated under the `system-admin` role; a
 * workspace user is evaluated under their workspace role.
 */
export function requireCapability(
  ctx: CapabilityContext,
  capability: Capability,
): void {
  const effective: Role | null = ctx.isPlatformAdmin
    ? 'system-admin'
    : (ctx.role ?? null);
  if (effective === null || !can(effective, capability)) {
    throw new CapabilityError(capability);
  }
}

/**
 * Switch the user's active workspace. A normal user may only switch to a
 * workspace they are a member of; a platform admin may switch to ANY workspace
 * (the deliberate cross-tenant break, §3A) and keeps a workspace role only if
 * they happen to be a member there.
 */
export function switchActiveWorkspace(
  memberships: readonly Membership[],
  target: string,
  isPlatformAdmin: boolean,
): WorkspaceContext {
  const role = resolveRole(memberships, target);
  if (role === null && !isPlatformAdmin) {
    throw new Error(`Not a member of workspace ${target}`);
  }
  // exactOptionalPropertyTypes: only set `role` when present.
  return role === null
    ? { workspaceId: target, isPlatformAdmin }
    : { workspaceId: target, role, isPlatformAdmin };
}

/**
 * Build the JWT claim set the authorizer injects for the active workspace (§12).
 * `workspace_id` is the authoritative active-workspace claim used to scope every
 * downstream read/write — never a client-supplied id (§13).
 */
export function buildJwtClaims(ctx: WorkspaceContext): ClaimSet {
  const base: ClaimSet = {
    sub: ctx.userId ?? '',
    workspace_id: ctx.workspaceId,
    is_platform_admin: ctx.isPlatformAdmin,
  };
  return ctx.role === undefined ? base : { ...base, role: ctx.role };
}

/**
 * True when a platform admin is acting against a workspace OTHER than the one in
 * their active claim — the case that must be audited (§3A). Non-admins can never
 * reach another workspace (RLS + scoping block them), so this is always false
 * for them.
 */
export function isCrossTenantAccess(
  ctx: { readonly workspaceId: string; readonly isPlatformAdmin: boolean },
  target: string,
): boolean {
  return ctx.isPlatformAdmin && target !== ctx.workspaceId;
}

/** A row to insert into `admin_audit_log` (§6). */
export interface AdminAuditEntry {
  readonly user_id: string;
  readonly workspace_id: string | null;
  readonly action: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Build a cross-tenant access audit entry (§3A guardrail). The actual INSERT is
 * performed by the API/service layer; this keeps the shape pure and testable.
 */
export function recordCrossTenantAccess(
  userId: string,
  workspaceId: string | null,
  action: string,
  detail?: Record<string, unknown>,
): AdminAuditEntry {
  return detail === undefined
    ? { user_id: userId, workspace_id: workspaceId, action }
    : { user_id: userId, workspace_id: workspaceId, action, detail };
}
