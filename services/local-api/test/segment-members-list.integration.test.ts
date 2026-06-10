// GET /segments/:id/members — a segment's materialized members, paginated (§12).
// REAL Postgres + workspace scoping.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e0c-0000-4000-8000-000000000a01';
const OTHER_WS = '0c0d0e0c-0000-4000-8000-000000000a02';
const USER = '0c0d0e0c-0000-4000-8000-0000000000b1';
const SEG = '0c0d0e0c-0000-4000-8000-0000000000d1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('segment members list (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS, OTHER_WS]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    await world.pool.query(
      "INSERT INTO segments (id, workspace_id, name, kind, definition) VALUES ($1,$2,'Hand picked','manual',NULL)",
      [SEG, WS],
    );
    // Three members.
    for (const e of ['c@acme.com', 'a@acme.com', 'b@acme.com']) {
      const r = await world.pool.query<{ id: string }>(
        'INSERT INTO profiles (workspace_id, email, email_status) VALUES ($1,$2,$3) RETURNING id',
        [WS, e, 'active'],
      );
      await world.pool.query(
        "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
        [SEG, r.rows[0]!.id, WS],
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
    await world.pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    for (const ws of [WS, OTHER_WS]) await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  it('returns the members (email-ordered) + total count', async () => {
    const r = await call(world.env, 'GET', `/segments/${SEG}/members`, { token: tok() });
    expect(r.status).toBe(200);
    const b = r.body as { size: number; page_size: number; members: Array<{ email: string }> };
    expect(b.size).toBe(3);
    expect(b.page_size).toBe(50);
    expect(b.members.map((m) => m.email)).toEqual(['a@acme.com', 'b@acme.com', 'c@acme.com']);
  });

  it('paginates by offset', async () => {
    const r = await call(world.env, 'GET', `/segments/${SEG}/members`, { token: tok(), query: { offset: '2' } });
    const b = r.body as { size: number; offset: number; members: Array<{ email: string }> };
    expect(b.size).toBe(3);
    expect(b.offset).toBe(2);
    expect(b.members.map((m) => m.email)).toEqual(['c@acme.com']);
  });

  it('404s for a segment outside the workspace', async () => {
    const r = await call(world.env, 'GET', `/segments/${SEG}/members`, { token: tokenFor(USER, OTHER_WS) });
    // USER has no membership in OTHER_WS → enforced as not found / forbidden, never another tenant's data.
    expect([403, 404]).toContain(r.status);
  });
});
