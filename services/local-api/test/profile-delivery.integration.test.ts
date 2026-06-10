// GET /profiles/:id/delivery — deliverability health (§10). REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e0b-0000-4000-8000-000000000a01';
const USER = '0c0d0e0b-0000-4000-8000-0000000000b1';
const P = '0c0d0e0b-0000-4000-8000-0000000000c1';
const EMAIL = 'health@acme.com';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('profile delivery health (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, email, email_status) VALUES ($1,$2,$3,'permanent_soft_bounce')",
      [P, WS, EMAIL],
    );
    await world.pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,$2,'permanent_soft_bounce','feedback')",
      [WS, EMAIL],
    );
    const ev = async (type: string, sub: string | null, at: string) =>
      world.pool.query(
        `INSERT INTO email_events (workspace_id, profile_id, type, sub_type, occurred_at, raw)
         VALUES ($1,$2,$3,$4,$5::timestamptz, jsonb_build_object('recipient',$6::text))`,
        [WS, P, type, sub, at, EMAIL],
      );
    await ev('delivery', null, '2026-01-01T10:00:00Z');
    await ev('bounce', 'Transient', '2026-01-02T10:00:00Z');
    await ev('bounce', 'Transient', '2026-01-03T10:00:00Z');
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM email_events WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM suppressions WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('returns status, suppression, soft-bounce day count, and recent events', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P}/delivery`, { token: tok() });
    expect(r.status).toBe(200);
    const b = r.body as {
      email_status: string;
      suppressed: { reason: string } | null;
      soft_bounce_days: number;
      events: Array<{ type: string }>;
    };
    expect(b.email_status).toBe('permanent_soft_bounce');
    expect(b.suppressed?.reason).toBe('permanent_soft_bounce');
    // 2 distinct soft-bounce days AFTER the last delivery (jan-02, jan-03).
    expect(b.soft_bounce_days).toBe(2);
    expect(b.events.length).toBe(3);
  });

  it('404s for a profile outside the workspace', async () => {
    const r = await call(world.env, 'GET', `/profiles/0c0d0e0b-0000-4000-8000-0000000000ff/delivery`, { token: tok() });
    expect(r.status).toBe(404);
  });
});
