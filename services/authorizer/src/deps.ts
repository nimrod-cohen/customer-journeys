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
import type { CompanyMembership, Membership, WorkspaceRole } from '@cdp/shared';
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

/** Resolve the user's single company membership (company_users, else workspace_users). */
export async function loadCompany(userId: string): Promise<CompanyMembership | null> {
  const cu = await getPool().query<{ company_id: string; role: string }>(
    'SELECT company_id, role FROM company_users WHERE user_id = $1 LIMIT 1',
    [userId],
  );
  const c = cu.rows[0];
  if (c && VALID_ROLES.has(c.role as WorkspaceRole)) {
    return { companyId: c.company_id, role: c.role as WorkspaceRole };
  }
  // Fallback for un-migrated data: highest workspace_users role + its company.
  const wu = await getPool().query<{ company_id: string; role: string }>(
    `SELECT w.company_id, wu.role
       FROM workspace_users wu
       JOIN workspaces w ON w.id = wu.workspace_id
      WHERE wu.user_id = $1
      ORDER BY (CASE wu.role WHEN 'owner' THEN 1 WHEN 'marketer' THEN 2 ELSE 3 END)
      LIMIT 1`,
    [userId],
  );
  const f = wu.rows[0];
  if (f && VALID_ROLES.has(f.role as WorkspaceRole)) {
    return { companyId: f.company_id, role: f.role as WorkspaceRole };
  }
  return null;
}

/** Load the workspaces the user may ACT in, from their company role (service-role connection). */
export async function loadMemberships(userId: string): Promise<readonly Membership[]> {
  const company = await loadCompany(userId);
  if (!company) return [];
  if (company.role === 'owner') {
    const { rows } = await getPool().query<{ id: string }>(
      'SELECT id FROM workspaces WHERE company_id = $1 ORDER BY name',
      [company.companyId],
    );
    return rows.map((r) => ({ workspaceId: r.id, role: 'owner' as WorkspaceRole }));
  }
  if (company.role === 'accounting') return [];
  const { rows } = await getPool().query<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_users WHERE user_id = $1',
    [userId],
  );
  return rows.map((r) => ({ workspaceId: r.workspace_id, role: 'marketer' as WorkspaceRole }));
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
    loadCompany,
    loadMemberships,
    loadIsPlatformAdmin,
  };
}
