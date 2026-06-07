// PG-backed authorizer lookups (§12). The same queries the production authorizer
// runs (deps.ts loadMemberships / loadIsPlatformAdmin), but bound to an explicit
// pool so integration tests can pass adminPool() directly. Service-role / admin
// connection → these read across the membership table by user_id (not workspace),
// which is exactly the authorizer's job (resolve which workspaces a user is in).
import type { Pool } from 'pg';
import type { Membership, WorkspaceRole } from '@cdp/shared';
import type { AuthorizerLookups } from './auth.js';

const VALID_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>([
  'owner',
  'marketer',
  'accounting',
]);

/** Build PG-backed authorizer lookups over a given pool. */
export function makePgLookups(pool: Pool): AuthorizerLookups {
  return {
    async loadMemberships(userId: string): Promise<readonly Membership[]> {
      const { rows } = await pool.query<{ workspace_id: string; role: string }>(
        'SELECT workspace_id, role FROM workspace_users WHERE user_id = $1',
        [userId],
      );
      return rows
        .filter((r): r is { workspace_id: string; role: WorkspaceRole } =>
          VALID_ROLES.has(r.role as WorkspaceRole),
        )
        .map((r) => ({ workspaceId: r.workspace_id, role: r.role }));
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
