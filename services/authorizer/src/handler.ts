// Lambda authorizer — thin handler (§12).
//
// Validates the Supabase JWT, resolves workspace membership + role (or
// is_platform_admin), and delegates the decision to the pure authorize() core,
// returning an API Gateway authorizer policy. All I/O (JWKS verification, DB
// lookups) is INJECTED so the handler stays thin and fully unit-testable.
import type { CompanyMembership, Membership } from '@cdp/shared';
import {
  authorize,
  buildAuthorizerPolicy,
  type DecodedJwt,
  type AuthorizerPolicy,
} from './authorize.js';

/** A REST API TOKEN-type authorizer event (the bits we use). */
export interface AuthorizerEvent {
  readonly type: 'TOKEN';
  readonly methodArn: string;
  readonly authorizationToken: string;
}

/** Injected dependencies — real implementations live in `deps.ts`. */
export interface AuthorizerDeps {
  /** Verify a Supabase JWT against JWKS; reject on bad signature/expiry. */
  verifyJwt(token: string): Promise<DecodedJwt>;
  /** The user's COMPANY membership (company-centric RBAC). Optional for legacy tests. */
  loadCompany?(userId: string): Promise<CompanyMembership | null>;
  /** Load the workspaces the user may ACT in (owner→all, marketer→grants, accounting→none). */
  loadMemberships(userId: string): Promise<readonly Membership[]>;
  /** Whether the user is in `platform_admins`. */
  loadIsPlatformAdmin(userId: string): Promise<boolean>;
}

const UNAUTHORIZED = 'Unauthorized';

function extractBearer(token: string): string | null {
  if (!token) return null;
  const m = /^Bearer\s+(.+)$/i.exec(token.trim());
  return m && m[1] ? m[1] : null;
}

/**
 * Build the authorizer handler from its injected dependencies. Throwing
 * `Unauthorized` makes API Gateway return 401 (token problems); a Deny policy
 * is returned for authenticated-but-not-authorized cases (403 at the route).
 */
export function makeAuthorizerHandler(deps: AuthorizerDeps) {
  return async function handler(event: AuthorizerEvent): Promise<AuthorizerPolicy> {
    const token = extractBearer(event.authorizationToken);
    if (!token) {
      // No/blank token → 401 (API GW maps the thrown "Unauthorized" string).
      throw new Error(UNAUTHORIZED);
    }

    let jwt: DecodedJwt;
    try {
      jwt = await deps.verifyJwt(token);
    } catch {
      throw new Error(UNAUTHORIZED);
    }

    const [company, memberships, isPlatformAdmin] = await Promise.all([
      deps.loadCompany ? deps.loadCompany(jwt.sub) : Promise.resolve(null),
      deps.loadMemberships(jwt.sub),
      deps.loadIsPlatformAdmin(jwt.sub),
    ]);

    const result = authorize(jwt, memberships, isPlatformAdmin, company);
    return buildAuthorizerPolicy(result, event.methodArn);
  };
}
