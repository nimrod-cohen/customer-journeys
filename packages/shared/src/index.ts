// @cdp/shared — cross-cutting types, env/config, workspace-aware logging.
// See CDP-BUILD-SPEC.md §3, §3A, §6, §12, §13, §19, §21.

/** Workspace-scoped roles stored in workspace_users.role (§3A). */
export type WorkspaceRole = 'owner' | 'marketer' | 'accounting';

/**
 * The four-role model (§3A). `system-admin` is platform-level (cross-tenant),
 * derived from membership in `platform_admins` — NOT from workspace_users.role.
 * The other three are workspace-scoped.
 */
export type Role = WorkspaceRole | 'system-admin';

/** Lifecycle status of a workspace (§6). */
export type WorkspaceStatus = 'onboarding' | 'active' | 'suspended';

/**
 * The capabilities the API gates on (§3A capability matrix). Routes declare a
 * required capability; `requireCapability` checks it against the resolved role.
 */
export type Capability =
  | 'view_all_workspaces' // cross-tenant company/workspace listing (system-admin only)
  | 'manage_workspace_users' // members + roles
  | 'manage_sending_domain' // sending domain / dedicated-IP upgrade
  | 'manage_content' // segments, broadcasts, campaigns, templates, profiles
  | 'view_billing'; // billing / spend / usage view

/**
 * A user's membership of a single workspace (a `workspace_users` row, §6).
 * A user may hold different roles in different workspaces.
 */
export interface Membership {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
}

/**
 * The custom JWT claims the authorizer injects (§12). `workspace_id` is the
 * ACTIVE workspace; it is never read from a client body (§13).
 */
export interface ClaimSet {
  /** Supabase auth user id (the `sub` claim). */
  readonly sub: string;
  /** The active workspace id (the workspace switcher's selection). */
  readonly workspace_id: string | null;
  /** True when the user is in `platform_admins` (the cross-tenant role). */
  readonly is_platform_admin: boolean;
  /** The user's role in the active workspace (absent for platform-admin-only). */
  readonly role?: WorkspaceRole;
}

/**
 * Tenancy context resolved by the authorizer (admin API) or from the API key
 * (ingest). `workspace_id` is NEVER taken from a client payload (§7, §13).
 */
export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly userId?: string;
  readonly role?: WorkspaceRole;
  readonly isPlatformAdmin: boolean;
}

/**
 * The result of authorizing a decoded JWT against the caller's membership and
 * platform-admin status (§12). Produced by the authorizer's pure core and then
 * turned into an API Gateway policy.
 */
export interface AuthResult {
  /** Whether the request is allowed past the gateway. */
  readonly allowed: boolean;
  /** Principal (Supabase user id) — present whenever the token verified. */
  readonly principalId?: string;
  /** The claims to inject into the request context for downstream Lambdas. */
  readonly claims?: ClaimSet;
  /** The effective role used for capability checks (§3A). */
  readonly effectiveRole?: Role;
  /** Human-readable reason when denied (logged, not returned to clients). */
  readonly reason?: string;
}
