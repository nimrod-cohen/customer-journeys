import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  adminPool,
  ensureTestAppRole,
  setSessionClaims,
  hasDatabaseUrl,
  TEST_APP_ROLE,
} from '../src/index.js';

// AC1 — Tenant isolation under RLS (§3, §18).
//
// REQUIRES a real local Postgres with the §6 migrations applied (Supabase CLI:
// `pnpm db:start && pnpm db:migrate`, or set DATABASE_URL to any migrated PG).
// Skips cleanly when no DATABASE_URL is configured so the unit tier stays green
// in environments without Docker/Supabase.
//
// CRITICAL: RLS must be exercised as a NON-BYPASSRLS role. We seed cross-
// workspace fixtures on the admin (BYPASSRLS) connection, then `SET ROLE` to the
// test app role inside a transaction and set the per-session JWT claim — exactly
// as PostgREST/Supabase does per request.

const RUN = hasDatabaseUrl();

describe.skipIf(!RUN)('RLS tenant isolation (AC1)', () => {
  let admin: Pool;
  const wsA = '11111111-1111-1111-1111-111111111111';
  const wsB = '22222222-2222-2222-2222-222222222222';
  const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  let profileA: string;
  let profileB: string;

  beforeAll(async () => {
    admin = adminPool();
    await ensureTestAppRole(admin);
    // Seed two workspaces with profiles sharing the same external_id (§3 / AC1).
    await admin.query('DELETE FROM profiles WHERE workspace_id IN ($1,$2)', [wsA, wsB]);
    await admin.query('DELETE FROM workspaces WHERE id IN ($1,$2)', [wsA, wsB]);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [
      wsA,
      wsB,
    ]);
    const a = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'cust-1','x@a.com') RETURNING id",
      [wsA],
    );
    const b = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'cust-1','x@b.com') RETURNING id",
      [wsB],
    );
    profileA = a.rows[0].id;
    profileB = b.rows[0].id;
  });

  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM profiles WHERE workspace_id IN ($1,$2)', [wsA, wsB]);
      await admin.query('DELETE FROM workspaces WHERE id IN ($1,$2)', [wsA, wsB]);
      await admin.end();
    }
  });

  /** Run a function as the non-BYPASSRLS test role with the given workspace claim. */
  async function asWorkspace<T>(
    workspaceId: string,
    fn: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await setSessionClaims(c, { workspace_id: workspaceId, sub: userA, is_platform_admin: false }, true);
      await c.query(`SET LOCAL ROLE ${TEST_APP_ROLE}`);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('a Workspace-A session reads only Workspace-A profiles', async () => {
    const rows = await asWorkspace(wsA, async (c) => {
      const r = await c.query('SELECT id, workspace_id FROM profiles');
      return r.rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(profileA);
    expect(rows[0].workspace_id).toBe(wsA);
  });

  it('a Workspace-A session CANNOT read Workspace-B rows even by id', async () => {
    const rows = await asWorkspace(wsA, async (c) => {
      const r = await c.query('SELECT id FROM profiles WHERE id = $1', [profileB]);
      return r.rows;
    });
    expect(rows.length).toBe(0);
  });

  it('a Workspace-A session CANNOT write a row tagged to Workspace-B (WITH CHECK)', async () => {
    await expect(
      asWorkspace(wsA, async (c) => {
        await c.query(
          "INSERT INTO profiles (workspace_id, external_id) VALUES ($1,'evil')",
          [wsB],
        );
      }),
    ).rejects.toThrow();
  });

  it('a Workspace-A session CANNOT update a Workspace-B profile', async () => {
    const updated = await asWorkspace(wsA, async (c) => {
      const r = await c.query(
        "UPDATE profiles SET email = 'hacked@a.com' WHERE id = $1 RETURNING id",
        [profileB],
      );
      return r.rowCount ?? 0;
    });
    expect(updated).toBe(0);
    // confirm B is untouched (admin read)
    const { rows } = await admin.query('SELECT email FROM profiles WHERE id = $1', [profileB]);
    expect(rows[0].email).toBe('x@b.com');
  });

  it('verifies the test role truly does NOT bypass RLS (guard against vacuous pass)', async () => {
    const { rows } = await admin.query(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = $1',
      [TEST_APP_ROLE],
    );
    expect(rows[0].rolbypassrls).toBe(false);
  });
});
