// Admin API service entrypoint (§12). Exposes the role-enforcement middleware
// and a production audit writer that INSERTs cross-tenant access into
// `admin_audit_log` (§3A). Route handlers (CRUD/read) are added in later phases;
// this phase delivers the tenancy/role enforcement layer they all sit behind.
import { getPool } from '@cdp/db';
import type { AdminAuditEntry } from '@cdp/tenancy';

export {
  contextFromAuthorizer,
  enforceRoute,
  handleAdminAccess,
  RouteForbiddenError,
  type RequestLike,
  type AuditWriter,
} from './middleware.js';

/** Production audit writer: persist a cross-tenant access to admin_audit_log. */
export async function writeAuditEntry(entry: AdminAuditEntry): Promise<void> {
  await getPool().query(
    'INSERT INTO admin_audit_log (user_id, workspace_id, action, detail) VALUES ($1, $2, $3, $4)',
    [entry.user_id, entry.workspace_id, entry.action, entry.detail ?? null],
  );
}
