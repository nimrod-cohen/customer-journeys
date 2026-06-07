import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { enrollFromSegmentChange, type EnrollDeps, type Reader } from '../src/enroll.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import type { SegmentChangeLogRow } from '../src/core.js';
import type { CampaignDefinition } from '../src/dsl.js';

// CRITICAL invariant: enrollment via segment entry. 'entered' enrolls into the
// campaign whose trigger_segment_id matches; 'exited' enrolls nobody;
// re-enrollment 'once' is structural (ON CONFLICT) — a second 'entered' inserts
// no duplicate.
const RUN = hasDatabaseUrl();
const WS = 'ca110000-0000-0000-0000-0000000000f5';
const CAMP = 'ca110000-0000-0000-0000-0000000000c5';
const SEG = 'ca110000-0000-0000-0000-0000000000a5';
const PROF = 'ca110000-0000-0000-0000-0000000000d6';

const DEF: CampaignDefinition = {
  startNode: 'trig',
  nodes: {
    trig: { type: 'trigger', kind: 'segment_entry', next: 'x' },
    x: { type: 'exit' },
  },
};

describe.skipIf(!RUN)('enrollment from segment entry (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await admin.query(
      "INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'seg','dynamic_realtime')",
      [SEG, WS],
    );
    await admin.query('INSERT INTO profiles (id, workspace_id, external_id) VALUES ($1,$2,$3)', [
      PROF,
      WS,
      'ext',
    ]);
    await admin.query(
      "INSERT INTO campaigns (id, workspace_id, name, definition, trigger_segment_id, status) VALUES ($1,$2,'C',$3::jsonb,$4,'active')",
      [CAMP, WS, JSON.stringify(DEF), SEG],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM segments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  function deps(): EnrollDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return { reader, runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s) };
  }

  it("'entered' enrolls the profile at the start node", async () => {
    const row: SegmentChangeLogRow = {
      workspace_id: WS,
      segment_id: SEG,
      profile_id: PROF,
      action: 'entered',
    };
    const res = await enrollFromSegmentChange(deps(), row);
    expect(res.enrolled).toBe(1);

    const e = await admin.query(
      'SELECT current_node, status FROM campaign_enrollments WHERE workspace_id = $1 AND campaign_id = $2 AND profile_id = $3',
      [WS, CAMP, PROF],
    );
    expect(e.rows).toHaveLength(1);
    expect(e.rows[0].current_node).toBe('trig');
    expect(e.rows[0].status).toBe('active');
  });

  it("a second 'entered' does NOT create a duplicate (re-enrollment 'once')", async () => {
    const row: SegmentChangeLogRow = {
      workspace_id: WS,
      segment_id: SEG,
      profile_id: PROF,
      action: 'entered',
    };
    await enrollFromSegmentChange(deps(), row);
    const c = await admin.query(
      'SELECT count(*)::int n FROM campaign_enrollments WHERE workspace_id = $1 AND campaign_id = $2 AND profile_id = $3',
      [WS, CAMP, PROF],
    );
    expect(c.rows[0].n).toBe(1);
  });

  it("'exited' enrolls nobody", async () => {
    // Use a fresh profile so the 'once' guard doesn't mask the result.
    const p2 = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id) VALUES ($1,'ext2') RETURNING id",
      [WS],
    );
    const row: SegmentChangeLogRow = {
      workspace_id: WS,
      segment_id: SEG,
      profile_id: p2.rows[0].id,
      action: 'exited',
    };
    const res = await enrollFromSegmentChange(deps(), row);
    expect(res.enrolled).toBe(0);
    const c = await admin.query(
      'SELECT count(*)::int n FROM campaign_enrollments WHERE workspace_id = $1 AND profile_id = $2',
      [WS, p2.rows[0].id],
    );
    expect(c.rows[0].n).toBe(0);
  });
});
