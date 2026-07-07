// PG-backed authorizer lookups (§12), company-centric RBAC. The same queries the
// production authorizer runs (deps.ts), bound to an explicit pool so integration
// tests can pass adminPool() directly. Service-role / admin connection.
//
// A user belongs to ONE company with a company ROLE (company_users). Their
// ACCESSIBLE workspaces are derived from that role:
//   - owner      → every workspace in the company
//   - marketer   → only the workspaces granted in workspace_users
//   - accounting → none (company-level billing only)
//
// FALLBACK: when the user has NO company_users row (un-migrated data), we derive
// the company + role from workspace_users (highest role wins) so a deploy that
// precedes the 0052 migration never locks anyone out.
import type { Pool } from 'pg';
import type { CompanyMembership, Membership, WorkspaceRole } from '@cdp/shared';
import type { AuthorizerLookups } from './auth.js';

const VALID_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>([
  'owner',
  'marketer',
  'accounting',
]);

/** Resolve the user's single company membership (company_users, else workspace_users). */
async function resolveCompany(pool: Pool, userId: string): Promise<CompanyMembership | null> {
  const cu = await pool.query<{ company_id: string; role: string }>(
    'SELECT company_id, role FROM company_users WHERE user_id = $1 LIMIT 1',
    [userId],
  );
  const c = cu.rows[0];
  if (c && VALID_ROLES.has(c.role as WorkspaceRole)) {
    return { companyId: c.company_id, role: c.role as WorkspaceRole };
  }
  // Fallback for un-migrated data: highest workspace_users role + its company.
  const wu = await pool.query<{ company_id: string; role: string }>(
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

/** Build PG-backed authorizer lookups over a given pool. */
export function makePgLookups(pool: Pool): AuthorizerLookups {
  return {
    async loadCompany(userId: string): Promise<CompanyMembership | null> {
      return resolveCompany(pool, userId);
    },
    async loadMemberships(userId: string): Promise<readonly Membership[]> {
      const company = await resolveCompany(pool, userId);
      if (!company) return [];
      if (company.role === 'owner') {
        // Owners access every workspace in their company.
        const { rows } = await pool.query<{ id: string }>(
          'SELECT id FROM workspaces WHERE company_id = $1 ORDER BY name',
          [company.companyId],
        );
        return rows.map((r) => ({ workspaceId: r.id, role: 'owner' as WorkspaceRole }));
      }
      if (company.role === 'accounting') {
        // Accounting is company-level billing only — no workspace access.
        return [];
      }
      // Marketer: only the workspaces granted via workspace_users.
      const { rows } = await pool.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM workspace_users WHERE user_id = $1',
        [userId],
      );
      return rows.map((r) => ({ workspaceId: r.workspace_id, role: 'marketer' as WorkspaceRole }));
    },
    async loadIsPlatformAdmin(userId: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        'SELECT 1 FROM platform_admins WHERE user_id = $1',
        [userId],
      );
      return (rowCount ?? 0) > 0;
    },
  };
}
