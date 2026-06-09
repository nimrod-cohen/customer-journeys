// The route table: maps a logical route key to the §3A Capability it requires
// (§12, §13). The HTTP server resolves a request to a route key and then calls
// enforceRoute(ctx, capability) — role enforcement is SERVER-SIDE and identical
// to what API Gateway + the API Lambdas do in production, independent of any UI
// hiding. Routes with `null` require only a valid authenticated context (any
// workspace member) — e.g. GET /me, POST /workspace/switch.
import type { Capability } from '@cdp/shared';

/** A route key: `${METHOD} ${pattern}` with `:param` placeholders. */
export type RouteKey = string;

/**
 * The required capability per route. `null` = authenticated-only (no specific
 * capability beyond a valid context). Patterns use `:id` for path params and are
 * matched by the resolver in ./match.ts.
 */
export const ROUTE_TABLE: Readonly<Record<RouteKey, Capability | null>> = {
  // --- session / identity (authenticated-only) ---
  'POST /auth/dev-login': null, // pre-auth; handled before enforcement
  'GET /me': null,
  'POST /workspace/switch': null,

  // --- workspace users + roles (manage_workspace_users) ---
  'GET /workspace/members': 'manage_workspace_users',
  'POST /workspace/members': 'manage_workspace_users',
  'PATCH /workspace/members': 'manage_workspace_users',
  'GET /workspace/settings': 'manage_workspace_users',
  'PUT /workspace/settings': 'manage_workspace_users',

  // --- sending domain (manage_sending_domain) ---
  'POST /sending-domain/start': 'manage_sending_domain',
  'POST /sending-domain/check': 'manage_sending_domain',
  'POST /sending-domain/activate': 'manage_sending_domain',

  // --- segments + audiences (manage_content) ---
  'GET /segments': 'manage_content',
  'GET /segments/:id': 'manage_content',
  'POST /segments': 'manage_content',
  'PUT /segments/:id': 'manage_content',
  'POST /segments/preview': 'manage_content',
  'POST /segments/:id/members': 'manage_content',
  'DELETE /segments/:id/members': 'manage_content',
  'POST /segments/:id/import-csv': 'manage_content',

  // --- templates (manage_content) ---
  'GET /templates': 'manage_content',
  'POST /templates': 'manage_content',

  // --- broadcasts (manage_content) ---
  'GET /broadcasts': 'manage_content',
  'POST /broadcasts': 'manage_content',
  'POST /broadcasts/:id/send': 'manage_content',

  // --- campaigns (manage_content) ---
  'GET /campaigns': 'manage_content',
  'POST /campaigns': 'manage_content',
  'PUT /campaigns/:id': 'manage_content',

  // --- profiles (manage_content) ---
  'GET /profiles': 'manage_content',
  'POST /profiles': 'manage_content',
  'POST /profiles/import-csv': 'manage_content',
  'GET /profiles/attribute-keys': 'manage_content',
  'GET /profiles/:id': 'manage_content',
  'PATCH /profiles/:id': 'manage_content',
  'POST /profiles/:id/merge': 'manage_content',
  'GET /profiles/:id/events': 'manage_content',
  'GET /profiles/:id/segments': 'manage_content',

  // --- activity log (manage_content) ---
  'GET /activity': 'manage_content',

  // --- dashboards (manage_content — marketer+ view) ---
  'GET /dashboards/summary': 'manage_content',

  // --- suppressions (manage_content) ---
  'GET /suppressions': 'manage_content',

  // --- billing / usage (view_billing) ---
  'GET /billing/usage': 'view_billing',

  // --- system-admin cross-tenant console (view_all_workspaces, audited) ---
  'GET /admin/companies': 'view_all_workspaces',
  'GET /admin/workspaces': 'view_all_workspaces',
  'GET /admin/workspaces/:id': 'view_all_workspaces',
};

/** Look up the capability for a route key. Throws if the route is unknown. */
export function capabilityForRoute(key: RouteKey): Capability | null {
  if (!Object.prototype.hasOwnProperty.call(ROUTE_TABLE, key)) {
    throw new Error(`unknown route: ${key}`);
  }
  return ROUTE_TABLE[key] ?? null;
}
