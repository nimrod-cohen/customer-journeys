// Live segment size preview (§12). POST /segments/preview compiles the rule AST
// via the §8 compiler (workspace_id structurally $1) and counts matching
// profiles in the ACTIVE workspace ONLY — it can NEVER count another workspace's
// profiles (§18 "never matches another workspace's profiles"). REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS_A = '0c0d0e03-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e03-0000-4000-8000-000000000a02';
const USER = '0c0d0e03-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('segment size preview (real Postgres)', () => {
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
    await world.pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'marketer')",
      [WS_A, USER],
    );
    // wsA: two VIP profiles + one non-VIP. wsB: a VIP that must NOT be counted.
    await seedProfile(WS_A, 'a1', 'a1@x.com', { tier: 'vip' });
    await seedProfile(WS_A, 'a2', 'a2@x.com', { tier: 'vip' });
    await seedProfile(WS_A, 'a3', 'a3@x.com', { tier: 'std' });
    await seedProfile(WS_B, 'b1', 'b1@x.com', { tier: 'vip' });
  });

  async function seedProfile(
    ws: string,
    ext: string,
    email: string,
    attrs: Record<string, unknown>,
  ): Promise<void> {
    const { rows } = await world.pool.query<{ id: string }>(
      'INSERT INTO profiles (workspace_id, external_id, email, attributes) VALUES ($1,$2,$3,$4::jsonb) RETURNING id',
      [ws, ext, email, JSON.stringify(attrs)],
    );
    await world.pool.query(
      'INSERT INTO profile_features (profile_id, workspace_id) VALUES ($1,$2)',
      [rows[0]!.id, ws],
    );
  }

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('counts only the active workspace profiles matching the AST (excludes other workspace)', async () => {
    const ast = { field: 'attributes.tier', operator: '=', value: 'vip' };
    const r = await call(world.env, 'POST', '/segments/preview', {
      token: tokenFor(USER, WS_A),
      body: { definition: ast },
    });
    expect(r.status).toBe(200);
    // 2 VIPs in wsA; the wsB VIP must NOT be counted.
    expect((r.body as { size: number }).size).toBe(2);
  });

  it('an empty/null AST counts ALL in-workspace profiles only', async () => {
    const r = await call(world.env, 'POST', '/segments/preview', {
      token: tokenFor(USER, WS_A),
      body: { definition: null },
    });
    expect((r.body as { size: number }).size).toBe(3);
  });

  it('an unknown field is rejected (compiler whitelist) → 500 from the handler', async () => {
    const ast = { field: 'attributes.tier; DROP TABLE profiles', operator: '=', value: 'x' };
    // attribute keys are bound as params, but a non-whitelisted scalar path throws;
    // here the attributes.* path is allowed, so use a bogus scalar to prove rejection.
    const bogus = { field: 'not_a_field', operator: '=', value: 1 };
    const r = await call(world.env, 'POST', '/segments/preview', {
      token: tokenFor(USER, WS_A),
      body: { definition: bogus },
    });
    expect(r.status).toBe(500);
    // The injection-y attribute key is harmless (bound as a param), proving safety.
    const r2 = await call(world.env, 'POST', '/segments/preview', {
      token: tokenFor(USER, WS_A),
      body: { definition: ast },
    });
    expect(r2.status).toBe(200);
    expect((r2.body as { size: number }).size).toBe(0);
  });
});
