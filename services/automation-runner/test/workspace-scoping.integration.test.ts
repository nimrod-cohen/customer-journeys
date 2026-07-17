import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { enrollFromSegmentChange, type EnrollDeps, type Reader } from '../src/enroll.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import { buildEnrollmentInsert } from '../src/core.js';
import type { SegmentChangeLogRow } from '../src/core.js';
import type { AutomationDefinition } from '../src/dsl.js';

// CRITICAL invariant: cross-workspace isolation. A segment_change_log row in WS_A
// must NEVER enroll into a WS_B automation (even when both automations share the same
// trigger_segment_id value). And runStatementsInWorkspaceTx REFUSES a statement
// not scoped to the requested workspace.
const RUN = hasDatabaseUrl();
const WS_A = 'ca110000-0000-0000-0000-0000000000fa';
const WS_B = 'ca110000-0000-0000-0000-0000000000fb';
const SEG_A = 'ca110000-0000-0000-0000-0000000000aa';
const SEG_B = 'ca110000-0000-0000-0000-0000000000ab';
const CAMP_A = 'ca110000-0000-0000-0000-0000000000ca';
const CAMP_B = 'ca110000-0000-0000-0000-0000000000cb';
const PROF_A = 'ca110000-0000-0000-0000-0000000000da';

const DEF: AutomationDefinition = {
  startNode: 't',
  nodes: { t: { type: 'trigger', kind: 'segment_entry', next: 'x' }, x: { type: 'exit' } },
};

describe.skipIf(!RUN)('automation workspace scoping (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const [ws, seg, camp] of [
      [WS_A, SEG_A, CAMP_A],
      [WS_B, SEG_B, CAMP_B],
    ] as const) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await admin.query(
        "INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'s','dynamic_realtime')",
        [seg, ws],
      );
      await admin.query(
        "INSERT INTO automations (id, workspace_id, name, definition, trigger_segment_id, status) VALUES ($1,$2,'C',$3::jsonb,$4,'active')",
        [camp, ws, JSON.stringify(DEF), seg],
      );
    }
    await admin.query('INSERT INTO profiles (id, workspace_id, external_id) VALUES ($1,$2,$3)', [
      PROF_A,
      WS_A,
      'ext',
    ]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    for (const ws of [WS_A, WS_B]) {
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM automations WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  function deps(): EnrollDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return { reader, runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s) };
  }

  it('a WS_A segment entry only enrolls into WS_A automations', async () => {
    const row: SegmentChangeLogRow = {
      workspace_id: WS_A,
      segment_id: SEG_A,
      profile_id: PROF_A,
      action: 'entered',
    };
    await enrollFromSegmentChange(deps(), row);

    const a = await admin.query(
      'SELECT count(*)::int n FROM automation_enrollments WHERE workspace_id = $1',
      [WS_A],
    );
    const b = await admin.query(
      'SELECT count(*)::int n FROM automation_enrollments WHERE workspace_id = $1',
      [WS_B],
    );
    expect(a.rows[0].n).toBe(1);
    expect(b.rows[0].n).toBe(0); // never bleeds into WS_B
  });

  it('runStatementsInWorkspaceTx refuses a statement scoped to another workspace', async () => {
    const stmtForB = buildEnrollmentInsert(WS_B, CAMP_B, PROF_A, 't');
    await expect(runStatementsInWorkspaceTx(admin, WS_A, [stmtForB])).rejects.toThrow(
      /not scoped to the requested workspace/,
    );
  });
});
