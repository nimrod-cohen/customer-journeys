// Delete a profile (§6/§12) — HARD delete + FULL erasure. REAL Postgres. Proves:
// DELETE /profiles/:id removes the profile AND every row that references it
// (events, messages_log, activity_log, segment_memberships, segment_change_log,
// campaign_enrollments, topic_subscriptions, channel_optouts, tracked_opens,
// profile_features) PLUS the suppressions row keyed by its email — all
// workspace-scoped. A cross-workspace / missing id → 404 and touches nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c1d2e0d-0000-4000-8000-000000000a01';
const WS_B = '0c1d2e0d-0000-4000-8000-000000000a02';
const USER = '0c1d2e0d-0000-4000-8000-0000000000b1';
const PROF = '0c1d2e0d-0000-4000-8000-0000000000c1';
const PROF_B = '0c1d2e0d-0000-4000-8000-0000000000c2';
const SEG = '0c1d2e0d-0000-4000-8000-0000000000d1';
const CAMP = '0c1d2e0d-0000-4000-8000-0000000000d2';
const TOPIC = '0c1d2e0d-0000-4000-8000-0000000000d3';
const EMAIL = 'del@acme.com';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('delete profile — hard delete + full erasure (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS, WS_B])
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);

    // The profile to delete (WS) + a same-email profile in WS_B (isolation check).
    await world.pool.query(
      'INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,$3,$4)',
      [PROF, WS, 'del', EMAIL],
    );
    await world.pool.query(
      'INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,$3,$4)',
      [PROF_B, WS_B, 'del', EMAIL],
    );

    // Parents needed by the child rows.
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'Seg','manual')", [SEG, WS]);
    await world.pool.query(
      `INSERT INTO campaigns (id, workspace_id, name, definition, status)
       VALUES ($1,$2,'Camp','{"startNode":"t","nodes":{}}'::jsonb,'active')`,
      [CAMP, WS],
    );
    await world.pool.query("INSERT INTO topics (id, workspace_id, name) VALUES ($1,$2,'News')", [TOPIC, WS]);

    // A child row in EVERY table that references the profile, for BOTH profiles
    // (so we can assert WS_B's rows survive when we delete PROF).
    for (const [id, ws] of [[PROF, WS], [PROF_B, WS_B]] as const) {
      await world.pool.query(
        "INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at) VALUES (gen_random_uuid(),$1,$2,'page_view',now())",
        [ws, id],
      );
      await world.pool.query(
        "INSERT INTO messages_log (workspace_id, profile_id, medium, status) VALUES ($1,$2,'email','sent')",
        [ws, id],
      );
      await world.pool.query(
        "INSERT INTO activity_log (workspace_id, profile_id, source, type, outcome) VALUES ($1,$2,'profile','profile_created','info')",
        [ws, id],
      );
      await world.pool.query('INSERT INTO profile_features (profile_id, workspace_id) VALUES ($1,$2)', [id, ws]);
      await world.pool.query(
        "INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'email')",
        [ws, id],
      );
      await world.pool.query(
        'INSERT INTO tracked_opens (token, workspace_id, profile_id, opens) VALUES ($1,$2,$3,1)',
        [`tok-${id}`, ws, id],
      );
      await world.pool.query(
        "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,$2,'manual','manual')",
        [ws, EMAIL],
      );
    }
    // WS-only children that need the WS parents (segment/campaign/topic).
    await world.pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG, PROF, WS],
    );
    await world.pool.query(
      "INSERT INTO segment_change_log (workspace_id, segment_id, profile_id, action) VALUES ($1,$2,$3,'entered')",
      [WS, SEG, PROF],
    );
    await world.pool.query(
      "INSERT INTO campaign_enrollments (workspace_id, campaign_id, profile_id, current_node, status) VALUES ($1,$2,$3,'t','active')",
      [WS, CAMP, PROF],
    );
    await world.pool.query(
      "INSERT INTO topic_subscriptions (workspace_id, profile_id, topic_id, subscribed) VALUES ($1,$2,$3,false)",
      [WS, PROF, TOPIC],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      await world.pool.query('DELETE FROM topic_subscriptions WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM channel_optouts WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM tracked_opens WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM topics WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segment_change_log WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM activity_log WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('a missing id and a cross-workspace id both 404 (and leave the foreign profile intact)', async () => {
    const stranger = '0c1d2e0d-0000-4000-8000-0000000000ff';
    expect((await call(world.env, 'DELETE', `/profiles/${stranger}`, { token: tok() })).status).toBe(404);
    // PROF_B lives in WS_B — deleting it with a WS token must 404, not erase it.
    expect((await call(world.env, 'DELETE', `/profiles/${PROF_B}`, { token: tok() })).status).toBe(404);
    const still = await world.pool.query('SELECT 1 FROM profiles WHERE id = $1', [PROF_B]);
    expect(still.rowCount).toBe(1);
  });

  it('hard-deletes the profile and erases every referencing row + its suppression', async () => {
    const r = await call(world.env, 'DELETE', `/profiles/${PROF}`, { token: tok() });
    expect(r.status).toBe(200);
    expect((r.body as { deleted: number }).deleted).toBe(1);

    // The profile is gone.
    expect((await world.pool.query('SELECT 1 FROM profiles WHERE id = $1', [PROF])).rowCount).toBe(0);

    // Every child table has no rows for the deleted profile.
    for (const table of [
      'events',
      'messages_log',
      'activity_log',
      'profile_features',
      'channel_optouts',
      'tracked_opens',
      'segment_memberships',
      'segment_change_log',
      'campaign_enrollments',
      'topic_subscriptions',
    ]) {
      const { rowCount } = await world.pool.query(`SELECT 1 FROM ${table} WHERE profile_id = $1`, [PROF]);
      expect(rowCount, `${table} should have no rows for the deleted profile`).toBe(0);
    }

    // The WS suppression for that email is erased (full erasure).
    expect(
      (await world.pool.query('SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = $2', [WS, EMAIL])).rowCount,
    ).toBe(0);

    // Tenant isolation: WS_B's same-email profile + its rows are untouched.
    expect((await world.pool.query('SELECT 1 FROM profiles WHERE id = $1', [PROF_B])).rowCount).toBe(1);
    expect((await world.pool.query('SELECT 1 FROM events WHERE profile_id = $1', [PROF_B])).rowCount).toBe(1);
    expect(
      (await world.pool.query('SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = $2', [WS_B, EMAIL])).rowCount,
    ).toBe(1);
  });
});
