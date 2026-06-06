// Real (production) authorizer dependencies (§12).
//
// - JWKS verification via `jose` against the Supabase project's JWKS endpoint.
// - Membership + platform-admin lookups via the pooled `pg` client.
//
// These are intentionally separated from the pure logic so unit tests inject
// fakes instead of touching the network or DB.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { getPool } from '@cdp/db';
import type { Membership, WorkspaceRole } from '@cdp/shared';
import type { AuthorizerDeps } from './handler.js';
import type { DecodedJwt } from './authorize.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

/** Build a `jose` JWKS verifier bound to the Supabase JWKS endpoint. */
export function makeJwtVerifier(): (token: string) => Promise<DecodedJwt> {
  const jwksUrl = requireEnv('SUPABASE_JWKS_URL');
  const issuer = process.env.SUPABASE_JWT_ISSUER;
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  return async (token: string): Promise<DecodedJwt> => {
    const { payload } = await jwtVerify(token, jwks, {
      ...(issuer ? { issuer } : {}),
    });
    return decodePayload(payload);
  };
}

/** Map a verified JWT payload to the claims the authorizer needs. */
export function decodePayload(payload: JWTPayload): DecodedJwt {
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const raw = (payload as Record<string, unknown>)['workspace_id'];
  const workspace_id = typeof raw === 'string' && raw.length > 0 ? raw : null;
  return { sub, workspace_id };
}

const VALID_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>([
  'owner',
  'marketer',
  'accounting',
]);

/** Load the user's memberships from `workspace_users` (service-role connection). */
export async function loadMemberships(userId: string): Promise<readonly Membership[]> {
  const { rows } = await getPool().query<{ workspace_id: string; role: string }>(
    'SELECT workspace_id, role FROM workspace_users WHERE user_id = $1',
    [userId],
  );
  return rows
    .filter((r): r is { workspace_id: string; role: WorkspaceRole } =>
      VALID_ROLES.has(r.role as WorkspaceRole),
    )
    .map((r) => ({ workspaceId: r.workspace_id, role: r.role }));
}

/** Whether the user is a platform admin (a `platform_admins` row). */
export async function loadIsPlatformAdmin(userId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    'SELECT 1 FROM platform_admins WHERE user_id = $1',
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

/** Assemble the production dependency set. */
export function makeProdDeps(): AuthorizerDeps {
  return {
    verifyJwt: makeJwtVerifier(),
    loadMemberships,
    loadIsPlatformAdmin,
  };
}
