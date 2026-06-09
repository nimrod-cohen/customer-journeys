// A user belongs to ONE company: adding them to a workspace owned by a different
// company than one they're already a member of is rejected (409). REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const CO_A = '0c0d0e05-0000-4000-8000-0000000000f1';
const CO_B = '0c0d0e05-0000-4000-8000-0000000000f2';
const WS_A = '0c0d0e05-0000-4000-8000-000000000a01'; // company A
const WS_B = '0c0d0e05-0000-4000-8000-000000000a02'; // company B
const ADMIN = '0c0d0e05-0000-4000-8000-0000000000b1';
const USER = '0c0d0e05-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('one company per user (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO companies (id, name) VALUES ($1,'Co A'),($2,'Co B')", [CO_A, CO_B]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'A','active',$2)", [WS_A, CO_A]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'B','active',$2)", [WS_B, CO_B]);
    await world.pool.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [ADMIN]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM platform_admins WHERE user_id = $1', [ADMIN]);
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
    await world.pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[CO_A, CO_B]]);
  }

  it('adds a user to one company, then rejects adding them to another company (409)', async () => {
    // Add USER to company A's workspace (platform admin can manage any workspace).
    const a = await call(world.env, 'POST', '/workspace/members', {
      token: tokenFor(ADMIN, WS_A),
      body: { user_id: USER, role: 'marketer' },
    });
    expect(a.status).toBe(201);

    // Adding the same user to company B's workspace is rejected.
    const b = await call(world.env, 'POST', '/workspace/members', {
      token: tokenFor(ADMIN, WS_B),
      body: { user_id: USER, role: 'marketer' },
    });
    expect(b.status).toBe(409);
    expect((b.body as { error: string }).error).toMatch(/another company/i);

    // The user was NOT added to company B's workspace.
    const { rowCount } = await world.pool.query('SELECT 1 FROM workspace_users WHERE workspace_id = $1 AND user_id = $2', [WS_B, USER]);
    expect(rowCount).toBe(0);
  });
});
