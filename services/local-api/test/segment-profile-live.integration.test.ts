// GET /profiles/:id/segments evaluates DYNAMIC segments LIVE (rule at now()), so:
//   - a segment the profile matches shows even with NO materialized row, and
//   - a STALE materialized row (profile no longer matches, e.g. aged out of a
//     time window) is IGNORED — the live rule wins.
// Manual memberships still come from the rows. REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e0f-0000-4000-8000-000000000a01';
const USER = '0c0d0e0f-0000-4000-8000-0000000000b1';
const P = '0c0d0e0f-0000-4000-8000-0000000000c1';
const SEG_RECENT = '0c0d0e0f-0000-4000-8000-0000000000d1'; // purchase within last 7 days
const SEG_VIP = '0c0d0e0f-0000-4000-8000-0000000000d2'; // tier = vip
const SEG_MANUAL = '0c0d0e0f-0000-4000-8000-0000000000d3'; // manual list

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('profile→segments is live (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    await world.pool.query(
      `INSERT INTO profiles (id, workspace_id, email, email_status, attributes)
       VALUES ($1,$2,'p@acme.com','active', jsonb_build_object('tier','vip'))`,
      [P, WS],
    );
    // A purchase 100 days ago (outside a 7-day window).
    await world.pool.query(
      `INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload)
       VALUES (gen_random_uuid(),$1,$2,'purchase', now() - interval '100 days', '{}'::jsonb)`,
      [WS, P],
    );
    await world.pool.query(
      `INSERT INTO segments (id, workspace_id, name, kind, status, definition)
       VALUES ($1,$2,'recent buyers','dynamic_realtime','active', $3::jsonb)`,
      [SEG_RECENT, WS, JSON.stringify({ event: 'purchase', withinDays: 7 })],
    );
    await world.pool.query(
      `INSERT INTO segments (id, workspace_id, name, kind, status, definition)
       VALUES ($1,$2,'VIP','dynamic_realtime','active', $3::jsonb)`,
      [SEG_VIP, WS, JSON.stringify({ field: 'attributes.tier', operator: '=', value: 'vip' })],
    );
    await world.pool.query(
      `INSERT INTO segments (id, workspace_id, name, kind, status, definition)
       VALUES ($1,$2,'hand list','manual','active', NULL)`,
      [SEG_MANUAL, WS],
    );
    // STALE evaluator row: P was materialized into 'recent buyers' when the purchase
    // was fresh; the cache was never cleaned. The live read must ignore it.
    await world.pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'evaluator')",
      [SEG_RECENT, P, WS],
    );
    // Manual membership for the hand list.
    await world.pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG_MANUAL, P, WS],
    );
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
    await world.pool.query('DELETE FROM events WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('shows live matches + manual, ignores stale dynamic cache rows', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P}/segments`, { token: tok() });
    expect(r.status).toBe(200);
    const segs = (r.body as { segments: Array<{ name: string; source: string }> }).segments;
    const byName = Object.fromEntries(segs.map((s) => [s.name, s.source]));

    // VIP matches the rule live → shown as 'live', even though it has NO membership row.
    expect(byName['VIP']).toBe('live');
    // hand list is a manual membership → shown from the rows.
    expect(byName['hand list']).toBe('manual');
    // recent buyers: a STALE evaluator row exists, but the purchase is 100 days old,
    // so the live 7-day rule excludes it → NOT shown.
    expect(byName['recent buyers']).toBeUndefined();
  });
});
