// GET /dashboards/summary: the `messages_sent` tile must count ACTUAL sends only.
// Since v0.63.0 every skip/failure also writes a messages_log row, so an unfiltered
// count over-reports. Real Postgres, workspace-scoped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e5a-0000-4000-8000-000000000a01';
const USER = '0c0d0e5a-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('dashboard summary: messages_sent counts only sent (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    const p = await world.pool.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'s','s@example.com') RETURNING id",
      [WS],
    );
    const pid = p.rows[0].id;
    // 2 sent, 1 skipped, 1 failed — messages_sent must be 2.
    await world.pool.query(
      "INSERT INTO messages_log (workspace_id, profile_id, status) VALUES ($1,$2,'sent'),($1,$2,'sent'),($1,$2,'skipped'),($1,$2,'failed')",
      [WS, pid],
    );
  });
  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('counts only status=sent, not skipped/failed rows', async () => {
    const r = await call(world.env, 'GET', '/dashboards/summary', { token: tok() });
    expect(r.status).toBe(200);
    expect((r.body as { messages_sent: number }).messages_sent).toBe(2);
  });
});
