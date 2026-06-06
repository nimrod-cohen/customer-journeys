import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  adminPool,
  ensureTestAppRole,
  setSessionClaims,
  hasDatabaseUrl,
  TEST_APP_ROLE,
} from '@cdp/db';
import { recordCrossTenantAccess } from '@cdp/tenancy';

// AC4 — cross-tenant system-admin access is recorded in admin_audit_log, and the
// table is platform-only under RLS (§3A, §6, §18). Requires real Postgres; skips
// cleanly otherwise.
const RUN = hasDatabaseUrl();

describe.skipIf(!RUN)('admin_audit_log cross-tenant audit (AC4)', () => {
  let admin: Pool;
  const adminUser = 'abababab-abab-abab-abab-abababababab';
  const wsTarget = 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd';

  beforeAll(async () => {
    admin = adminPool();
    await ensureTestAppRole(admin);
    await admin.query('DELETE FROM admin_audit_log WHERE user_id = $1', [adminUser]);
  });

  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM admin_audit_log WHERE user_id = $1', [adminUser]);
      await admin.end();
    }
  });

  it('persists a cross-tenant access entry (who / which workspace / what)', async () => {
    const entry = recordCrossTenantAccess(adminUser, wsTarget, 'read_profiles', {
      count: 5,
    });
    await admin.query(
      'INSERT INTO admin_audit_log (user_id, workspace_id, action, detail) VALUES ($1,$2,$3,$4)',
      [entry.user_id, entry.workspace_id, entry.action, entry.detail],
    );
    const { rows } = await admin.query(
      'SELECT user_id, workspace_id, action, detail FROM admin_audit_log WHERE user_id = $1',
      [adminUser],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(wsTarget);
    expect(rows[0].action).toBe('read_profiles');
    expect(rows[0].detail).toEqual({ count: 5 });
  });

  it('admin_audit_log is platform-only under RLS (a workspace user cannot read it)', async () => {
    const c: PoolClient = await admin.connect();
    try {
      await c.query('BEGIN');
      await setSessionClaims(
        c,
        { workspace_id: wsTarget, sub: 'someuser', is_platform_admin: false },
        true,
      );
      await c.query(`SET LOCAL ROLE ${TEST_APP_ROLE}`);
      const r = await c.query('SELECT count(*)::int AS n FROM admin_audit_log');
      expect(r.rows[0].n).toBe(0); // RLS hides all rows from a non-admin
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('a platform-admin session CAN read the audit log', async () => {
    const c: PoolClient = await admin.connect();
    try {
      await c.query('BEGIN');
      await setSessionClaims(c, { sub: adminUser, is_platform_admin: true }, true);
      await c.query(`SET LOCAL ROLE ${TEST_APP_ROLE}`);
      const r = await c.query(
        'SELECT count(*)::int AS n FROM admin_audit_log WHERE user_id = $1',
        [adminUser],
      );
      expect(r.rows[0].n).toBe(1);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
