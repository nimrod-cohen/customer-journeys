import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  adminPool,
  ensureTestAppRole,
  setSessionClaims,
  hasDatabaseUrl,
  TEST_APP_ROLE,
} from '../src/index.js';

// AC5 — switching the active workspace re-scopes every read with no cross-bleed
// (§12, §18). A single user belongs to two workspaces; changing only the JWT
// `workspace_id` claim flips which rows RLS exposes.
const RUN = hasDatabaseUrl();

describe.skipIf(!RUN)('workspace switch re-scoping (AC5)', () => {
  let admin: Pool;
  const wsA = '55555555-5555-5555-5555-555555555555';
  const wsB = '66666666-6666-6666-6666-666666666666';
  const user = '77777777-7777-7777-7777-777777777777';

  beforeAll(async () => {
    admin = adminPool();
    await ensureTestAppRole(admin);
    await admin.query('DELETE FROM profiles WHERE workspace_id IN ($1,$2)', [wsA, wsB]);
    await admin.query('DELETE FROM workspace_users WHERE workspace_id IN ($1,$2)', [wsA, wsB]);
    await admin.query('DELETE FROM workspaces WHERE id IN ($1,$2)', [wsA, wsB]);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
    await admin.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$3,'owner'),($2,$3,'marketer')",
      [wsA, wsB, user],
    );
    await admin.query("INSERT INTO profiles (workspace_id, external_id) VALUES ($1,'a-only')", [wsA]);
    await admin.query("INSERT INTO profiles (workspace_id, external_id) VALUES ($1,'b-only')", [wsB]);
  });

  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM profiles WHERE workspace_id IN ($1,$2)', [wsA, wsB]);
      await admin.query('DELETE FROM workspace_users WHERE workspace_id IN ($1,$2)', [wsA, wsB]);
      await admin.query('DELETE FROM workspaces WHERE id IN ($1,$2)', [wsA, wsB]);
      await admin.end();
    }
  });

  async function externalIdsFor(activeWs: string): Promise<string[]> {
    const c: PoolClient = await admin.connect();
    try {
      await c.query('BEGIN');
      await setSessionClaims(c, { workspace_id: activeWs, sub: user, is_platform_admin: false }, true);
      await c.query(`SET LOCAL ROLE ${TEST_APP_ROLE}`);
      const r = await c.query('SELECT external_id FROM profiles ORDER BY external_id');
      return r.rows.map((row: { external_id: string }) => row.external_id);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('active=A shows only A rows; active=B shows only B rows', async () => {
    expect(await externalIdsFor(wsA)).toEqual(['a-only']);
    expect(await externalIdsFor(wsB)).toEqual(['b-only']);
  });
});
