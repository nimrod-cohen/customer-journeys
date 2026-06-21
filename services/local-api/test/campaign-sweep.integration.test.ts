// Local campaign-enrollment sweep (§9B, v0.46.0) — the dev-server stand-in for the
// production EventBridge campaign sweep (scheduledSweepHandler → buildSweepQuery →
// runEnrollment). Regression: enrollments were CREATED in dev but never ADVANCED,
// so set_attribute/wait/send steps never ran. This proves a due enrollment is
// ticked to completion (its set_attribute side effect lands) and that the sweep is
// workspace-isolated (each profile update stays in its own workspace).
//
// REAL Postgres (DATABASE_URL). No SES/SQS/HTTP — the campaign is set_attribute →
// exit only (no outbox rows), so the local outbox dispatch is a no-op.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makeLocalDeps } from '../src/index.js';
import { sweepDueCampaignEnrollments } from '../src/handlers.js';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// A free workspace-id prefix (0c0d0eba**) not used by any other integration spec.
const WS_A = '0c0d0eba-0000-4000-8000-000000000a01';
const WS_B = '0c0d0eba-0000-4000-8000-000000000a02';
const CAMP_A = '0c0d0eba-0000-4000-8000-0000000000c1';
const CAMP_B = '0c0d0eba-0000-4000-8000-0000000000c2';
const PROF_A = '0c0d0eba-0000-4000-8000-0000000000f1';
const PROF_B = '0c0d0eba-0000-4000-8000-0000000000f2';

// trigger(profile,any) → set_attribute(first_name = js from customer.name) → exit.
// A sandboxed JS value spec reads the profile's own `name` attribute (customer.*).
const def = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'profile', profileChange: 'any', next: 'attr' },
    attr: {
      type: 'action',
      kind: 'set_attribute',
      key: 'first_name',
      value: { kind: 'js', code: 'return customer.name.split(" ")[0]' },
      next: 'x',
    },
    x: { type: 'exit' },
  },
};

describeMaybe('local campaign-enrollment sweep advances due enrollments (real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    for (const [ws, camp, prof, fullName] of [
      [WS_A, CAMP_A, PROF_A, 'Ada Lovelace'],
      [WS_B, CAMP_B, PROF_B, 'Grace Hopper'],
    ] as const) {
      await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await pool.query(
        "INSERT INTO campaigns (id, workspace_id, name, definition, status) VALUES ($1,$2,'Welcome',$3::jsonb,'active')",
        [camp, ws, JSON.stringify(def)],
      );
      await pool.query(
        "INSERT INTO profiles (id, workspace_id, email, attributes) VALUES ($1,$2,$3,$4::jsonb)",
        [prof, ws, `${prof}@example.com`, JSON.stringify({ name: fullName })],
      );
      // A DUE enrollment parked at the trigger (next_run_at in the PAST).
      await pool.query(
        `INSERT INTO campaign_enrollments (workspace_id, campaign_id, profile_id, current_node, status, next_run_at)
         VALUES ($1,$2,$3,'t','active', now() - interval '1 minute')`,
        [ws, camp, prof],
      );
    }
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS_A, WS_B]) {
      await pool.query('DELETE FROM activity_log WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('ticks every due enrollment to completion and lands its set_attribute (workspace-isolated)', async () => {
    const processed = await sweepDueCampaignEnrollments(pool, makeLocalDeps(pool));
    // The sweep is GLOBAL (cross-workspace, like the production cron) — it processes
    // at least OUR two due enrollments (one per workspace); the dev DB may hold other
    // due enrollments too, so assert ≥ 2 and verify our two specifically below.
    expect(processed).toBeGreaterThanOrEqual(2);

    // Each enrollment advanced to completion (no longer parked at the trigger).
    const enr = await pool.query<{ workspace_id: string; status: string; current_node: string }>(
      'SELECT workspace_id, status, current_node FROM campaign_enrollments WHERE workspace_id = ANY($1) ORDER BY workspace_id',
      [[WS_A, WS_B]],
    );
    expect(enr.rows).toHaveLength(2);
    for (const r of enr.rows) {
      expect(r.status).toBe('completed');
      expect(r.current_node).toBe('x');
    }

    // The set_attribute side effect landed — and stayed in its OWN workspace.
    const a = await pool.query<{ attributes: { first_name?: string; name?: string } }>(
      'SELECT attributes FROM profiles WHERE id = $1 AND workspace_id = $2',
      [PROF_A, WS_A],
    );
    const b = await pool.query<{ attributes: { first_name?: string; name?: string } }>(
      'SELECT attributes FROM profiles WHERE id = $1 AND workspace_id = $2',
      [PROF_B, WS_B],
    );
    expect(a.rows[0]!.attributes.first_name).toBe('Ada');
    expect(b.rows[0]!.attributes.first_name).toBe('Grace');

    // Isolation: WS_A's profile only ever got WS_A's value (and vice-versa).
    expect(a.rows[0]!.attributes.first_name).not.toBe('Grace');
    expect(b.rows[0]!.attributes.first_name).not.toBe('Ada');
  });

  it('is idempotent for OUR enrollments: a second sweep leaves them completed & unchanged', async () => {
    // OUR two enrollments are already completed, so they are no longer due — the
    // sweep must not re-tick them (their values stay put). The GLOBAL count may be
    // non-zero from unrelated dev data, so we assert on our own rows only.
    await sweepDueCampaignEnrollments(pool, makeLocalDeps(pool));
    const enr = await pool.query<{ status: string; current_node: string }>(
      'SELECT status, current_node FROM campaign_enrollments WHERE workspace_id = ANY($1)',
      [[WS_A, WS_B]],
    );
    for (const r of enr.rows) {
      expect(r.status).toBe('completed');
      expect(r.current_node).toBe('x');
    }
    const a = await pool.query<{ attributes: { first_name?: string } }>(
      'SELECT attributes FROM profiles WHERE id = $1 AND workspace_id = $2',
      [PROF_A, WS_A],
    );
    expect(a.rows[0]!.attributes.first_name).toBe('Ada');
  });
});
