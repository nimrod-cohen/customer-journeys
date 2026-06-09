// system-admin is the ONLY cross-tenant role and EVERY cross-tenant access is
// written to admin_audit_log (§3A, §18 "Roles"). REAL Postgres. We seed a
// platform admin (no workspace membership) + two workspaces, then prove:
//   - the admin can list all workspaces and read another workspace's row,
//   - a non-admin is 403 on the same routes,
//   - each cross-tenant read writes an admin_audit_log entry (who/which/what).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS_A = '0c0d0e02-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e02-0000-4000-8000-000000000a02';
const ADMIN = '0c0d0e02-0000-4000-8000-0000000000b1';
const MEMBER = '0c0d0e02-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('system-admin cross-tenant audit (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query(
        "INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')",
        [ws],
      );
    }
    await world.pool.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [ADMIN]);
    await world.pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS_A, MEMBER],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM admin_audit_log WHERE user_id = $1', [ADMIN]);
    await world.pool.query('DELETE FROM platform_admins WHERE user_id = $1', [ADMIN]);
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  async function auditCount(): Promise<number> {
    const { rows } = await world.pool.query<{ c: string }>(
      'SELECT count(*)::int AS c FROM admin_audit_log WHERE user_id = $1',
      [ADMIN],
    );
    return Number(rows[0]?.c ?? 0);
  }

  it('a platform admin reading ANOTHER workspace writes an audit entry', async () => {
    const before = await auditCount();
    // The admin's active claim is WS_A; reading WS_B is the cross-tenant case.
    const t = tokenFor(ADMIN, WS_A);
    const r = await call(world.env, 'GET', `/admin/workspaces/${WS_B}`, { token: t });
    expect(r.status).toBe(200);
    expect((r.body as { workspace: { id: string } }).workspace.id).toBe(WS_B);
    const after = await auditCount();
    expect(after).toBe(before + 1);

    const { rows } = await world.pool.query<{ action: string; workspace_id: string }>(
      'SELECT action, workspace_id FROM admin_audit_log WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
      [ADMIN],
    );
    expect(rows[0]?.action).toBe('admin.read_workspace');
    expect(rows[0]?.workspace_id).toBe(WS_B);
  });

  it('listing all workspaces is audited', async () => {
    const before = await auditCount();
    const r = await call(world.env, 'GET', '/admin/workspaces', { token: tokenFor(ADMIN, WS_A) });
    expect(r.status).toBe(200);
    expect((r.body as { workspaces: unknown[] }).workspaces.length).toBeGreaterThanOrEqual(2);
    expect(await auditCount()).toBe(before + 1);
  });

  it('a non-admin member is 403 on the admin console (and writes no audit)', async () => {
    const before = await auditCount();
    const r = await call(world.env, 'GET', '/admin/workspaces', { token: tokenFor(MEMBER, WS_A) });
    expect(r.status).toBe(403);
    expect(await auditCount()).toBe(before);
  });

  it('lists companies with their workspaces (audited); /me carries the active company', async () => {
    const t = tokenFor(ADMIN, WS_A);
    const before = await auditCount();
    const r = await call(world.env, 'GET', '/admin/companies', { token: t });
    expect(r.status).toBe(200);
    const companies = (r.body as { companies: Array<{ id: string; workspaces: Array<{ id: string }> }> }).companies;
    // WS_A's (auto-created) parent company contains WS_A.
    expect(companies.some((c) => c.workspaces.some((w) => w.id === WS_A))).toBe(true);
    expect(await auditCount()).toBe(before + 1); // cross-tenant read is audited

    const me = await call(world.env, 'GET', '/me', { token: t });
    expect((me.body as { company_id: string | null }).company_id).toBeTruthy();
    expect((me.body as { company_name: string | null }).company_name).toBeTruthy();
  });

  it('a non-admin member is 403 on /admin/companies', async () => {
    const r = await call(world.env, 'GET', '/admin/companies', { token: tokenFor(MEMBER, WS_A) });
    expect(r.status).toBe(403);
  });
});
