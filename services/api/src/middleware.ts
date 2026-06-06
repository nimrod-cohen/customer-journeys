// Admin API route role-enforcement + cross-tenant audit (§3A, §12, §13).
//
// The authorizer (services/authorizer) injects the authoritative identity into
// the API Gateway request context as STRING values. The API reads ONLY from
// there — never from the client body — then enforces the route's required
// capability and audits any cross-tenant system-admin access.
import type { Capability, WorkspaceContext } from '@cdp/shared';
import {
  requireCapability,
  CapabilityError,
  isCrossTenantAccess,
  recordCrossTenantAccess,
  type AdminAuditEntry,
} from '@cdp/tenancy';

/** The slice of an API Gateway proxy event we rely on. */
export interface RequestLike {
  readonly requestContext: {
    readonly authorizer?: Record<string, string | undefined> | undefined;
  };
}

/** Thrown when a route's capability check fails → HTTP 403. */
export class RouteForbiddenError extends Error {
  readonly capability: Capability;
  constructor(capability: Capability) {
    super(`Forbidden: requires ${capability}`);
    this.name = 'RouteForbiddenError';
    this.capability = capability;
  }
}

/**
 * Build the trusted WorkspaceContext from the authorizer-injected context.
 * Throws if absent — a route must never run without an authenticated context
 * (defense in depth behind the gateway authorizer).
 */
export function contextFromAuthorizer(event: RequestLike): WorkspaceContext {
  const a = event.requestContext.authorizer;
  if (!a || !a.sub || !a.workspace_id) {
    throw new Error('missing authorizer context');
  }
  const isPlatformAdmin = a.is_platform_admin === 'true';
  const role = a.role;
  const base = {
    workspaceId: a.workspace_id,
    userId: a.sub,
    isPlatformAdmin,
  };
  return role === 'owner' || role === 'marketer' || role === 'accounting'
    ? { ...base, role }
    : base;
}

/**
 * Enforce a route's required capability against the trusted context, mapping a
 * capability failure to a RouteForbiddenError (403).
 */
export function enforceRoute(ctx: WorkspaceContext, capability: Capability): void {
  try {
    requireCapability(
      ctx.role === undefined
        ? { isPlatformAdmin: ctx.isPlatformAdmin }
        : { role: ctx.role, isPlatformAdmin: ctx.isPlatformAdmin },
      capability,
    );
  } catch (e) {
    if (e instanceof CapabilityError) throw new RouteForbiddenError(capability);
    throw e;
  }
}

/** Persist an audit entry (injected — real impl INSERTs into admin_audit_log). */
export type AuditWriter = (entry: AdminAuditEntry) => Promise<void>;

/**
 * If the request is a cross-tenant system-admin access (the only case that
 * crosses workspaces, §3A), write an `admin_audit_log` entry. No-op otherwise.
 * `targetWorkspaceId` is the workspace the operation actually touches.
 */
export async function handleAdminAccess(
  ctx: WorkspaceContext,
  targetWorkspaceId: string,
  action: string,
  detail: Record<string, unknown>,
  writeAudit: AuditWriter,
): Promise<void> {
  if (!isCrossTenantAccess(ctx, targetWorkspaceId)) return;
  const entry = recordCrossTenantAccess(
    ctx.userId ?? '',
    targetWorkspaceId,
    action,
    detail,
  );
  await writeAudit(entry);
}
