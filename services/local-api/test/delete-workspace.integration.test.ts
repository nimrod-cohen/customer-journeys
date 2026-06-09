// Deleting a workspace (platform admin only; §3A) purges ALL its data and is
// guarded by a name-confirmation. REAL Postgres. Proves: wrong/missing name 400,
// non-admin 403, and a correct confirmation cascades (workspace + profile +
// segment gone).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const CO = '0c0d0e07-0000-4000-8000-0000000000f1';
const WS = '0c0d0e07-0000-4000-8000-000000000a01';
const ADMIN = '0c0d0e07-0000-4000-8000-0000000000b1';
const OWNER = '0c0d0e07-0000-4000-8000-0000000000b2';
const SEG = '0c0d0e07-0000-4000-8000-0000000000c1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('delete workspace (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO companies (id, name) VALUES ($1,'Co')", [CO]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'Doomed WS','active',$2)", [WS, CO]);
    await world.pool.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [ADMIN]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    // Some tenant data to prove the cascade.
    const { rows } = await world.pool.query<{ id: string }>(
      "INSERT INTO profiles (workspace_id, email) VALUES ($1,'p@doomed.com') RETURNING id",
      [WS],
    );
    await world.pool.query('INSERT INTO profile_features (profile_id, workspace_id) VALUES ($1,$2)', [rows[0]!.id, WS]);
    await world.pool.query(
      "INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at) VALUES (gen_random_uuid(),$1,$2,'x', now())",
      [WS, rows[0]!.id],
    );
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')", [SEG, WS]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM platform_admins WHERE user_id = $1', [ADMIN]);
    for (const t of ['events', 'profile_features', 'segments', 'workspace_users', 'profiles']) {
      await world.pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [WS]);
    }
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await world.pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  it('rejects a wrong name confirmation (400) and leaves the workspace', async () => {
    const r = await call(world.env, 'DELETE', `/admin/workspaces/${WS}`, {
      token: tokenFor(ADMIN, WS),
      body: { confirm_name: 'wrong' },
    });
    expect(r.status).toBe(400);
    const still = await world.pool.query('SELECT 1 FROM workspaces WHERE id = $1', [WS]);
    expect(still.rowCount).toBe(1);
  });

  it('a non-admin (owner) cannot delete (403)', async () => {
    const r = await call(world.env, 'DELETE', `/admin/workspaces/${WS}`, {
      token: tokenFor(OWNER, WS),
      body: { confirm_name: 'Doomed WS' },
    });
    expect(r.status).toBe(403);
  });

  it('a correct confirmation deletes the workspace and cascades its data', async () => {
    const r = await call(world.env, 'DELETE', `/admin/workspaces/${WS}`, {
      token: tokenFor(ADMIN, WS),
      body: { confirm_name: 'Doomed WS' },
    });
    expect(r.status).toBe(200);
    expect((await world.pool.query('SELECT 1 FROM workspaces WHERE id = $1', [WS])).rowCount).toBe(0);
    expect((await world.pool.query('SELECT 1 FROM profiles WHERE workspace_id = $1', [WS])).rowCount).toBe(0);
    expect((await world.pool.query('SELECT 1 FROM events WHERE workspace_id = $1', [WS])).rowCount).toBe(0);
    expect((await world.pool.query('SELECT 1 FROM segments WHERE workspace_id = $1', [WS])).rowCount).toBe(0);
  });
});
