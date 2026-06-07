// Role enforcement is SERVER-SIDE (§3A, §18 "Roles"), independent of any UI
// hiding, proven against REAL Postgres. We seed one workspace with an owner, a
// marketer, and an accounting user, then drive the dispatch pipeline (the same
// one the HTTP server uses) and assert each role's allowed/denied routes by the
// authorizer + enforceRoute(routeTable), not by trusting the client.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e00-0000-4000-8000-000000000a01';
const OWNER = '0c0d0e00-0000-4000-8000-0000000000b1';
const MKT = '0c0d0e00-0000-4000-8000-0000000000b2';
const ACC = '0c0d0e00-0000-4000-8000-0000000000b3';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('router role enforcement (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query(
      "INSERT INTO workspaces (id, name, status) VALUES ($1,'Acme','active')",
      [WS],
    );
    for (const [u, role] of [
      [OWNER, 'owner'],
      [MKT, 'marketer'],
      [ACC, 'accounting'],
    ] as const) {
      await world.pool.query(
        'INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,$3)',
        [WS, u, role],
      );
    }
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
  }

  it('marketer is 403 on billing, user-management, and sending-domain routes', async () => {
    const t = tokenFor(MKT, WS);
    const billing = await call(world.env, 'GET', '/billing/usage', { token: t });
    const members = await call(world.env, 'GET', '/workspace/members', { token: t });
    const domain = await call(world.env, 'POST', '/sending-domain/check', { token: t });
    expect(billing.status).toBe(403);
    expect(members.status).toBe(403);
    expect(domain.status).toBe(403);
  });

  it('marketer CAN manage content (segments)', async () => {
    const t = tokenFor(MKT, WS);
    const segs = await call(world.env, 'GET', '/segments', { token: t });
    expect(segs.status).toBe(200);
  });

  it('accounting can view billing but cannot edit content', async () => {
    const t = tokenFor(ACC, WS);
    const billing = await call(world.env, 'GET', '/billing/usage', { token: t });
    const createSeg = await call(world.env, 'POST', '/segments', {
      token: t,
      body: { name: 'x', kind: 'manual' },
    });
    expect(billing.status).toBe(200);
    expect(createSeg.status).toBe(403);
  });

  it('owner can manage users, domain, content, and billing', async () => {
    const t = tokenFor(OWNER, WS);
    const members = await call(world.env, 'GET', '/workspace/members', { token: t });
    const billing = await call(world.env, 'GET', '/billing/usage', { token: t });
    const segs = await call(world.env, 'GET', '/segments', { token: t });
    expect(members.status).toBe(200);
    expect(billing.status).toBe(200);
    expect(segs.status).toBe(200);
  });

  it('non-system-admin cannot reach the cross-tenant admin console (403)', async () => {
    const t = tokenFor(OWNER, WS);
    const admin = await call(world.env, 'GET', '/admin/workspaces', { token: t });
    expect(admin.status).toBe(403);
  });

  it('no token → 401', async () => {
    const r = await call(world.env, 'GET', '/segments', { token: null });
    expect(r.status).toBe(401);
  });
});
