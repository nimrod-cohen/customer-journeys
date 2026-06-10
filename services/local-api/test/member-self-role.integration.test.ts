// A user cannot change their OWN role (no self-demotion) — only another owner
// can change someone's role (§3A). REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const CO = '0c0d0e0a-0000-4000-8000-0000000000f1';
const WS = '0c0d0e0a-0000-4000-8000-000000000a01';
const OWNER = '0c0d0e0a-0000-4000-8000-0000000000b1';
const OTHER = '0c0d0e0a-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('self role change guard (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO companies (id, name) VALUES ($1,'Co')", [CO]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'WS','active',$2)", [WS, CO]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OTHER]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await world.pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  const role = async (uid: string) =>
    (await world.pool.query<{ role: string }>('SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2', [WS, uid])).rows[0]?.role;

  it('an owner CANNOT demote themselves (403, role unchanged)', async () => {
    const r = await call(world.env, 'PATCH', '/workspace/members', {
      token: tokenFor(OWNER, WS),
      body: { user_id: OWNER, role: 'marketer' },
    });
    expect(r.status).toBe(403);
    expect(await role(OWNER)).toBe('owner');
  });

  it('cannot change own role via addMember either (403)', async () => {
    const r = await call(world.env, 'POST', '/workspace/members', {
      token: tokenFor(OWNER, WS),
      body: { user_id: OWNER, role: 'marketer' },
    });
    expect(r.status).toBe(403);
    expect(await role(OWNER)).toBe('owner');
  });

  it('an owner CAN change ANOTHER member down to marketer', async () => {
    const r = await call(world.env, 'PATCH', '/workspace/members', {
      token: tokenFor(OWNER, WS),
      body: { user_id: OTHER, role: 'marketer' },
    });
    expect(r.status).toBe(200);
    expect(await role(OTHER)).toBe('marketer');
  });
});
