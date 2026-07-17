import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runBatchEvalForWorkspace, type BatchEvalDeps } from '../src/core.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// AC "Segmentation" (batch path) on REAL Postgres (§8, §18). The batch sweep runs
// as the SERVICE ROLE (bypasses RLS) on the admin pool — isolation is in-code
// workspace_id=$1 scoping. Proves enter-once/exit-once and cross-workspace
// isolation for the dynamic_batch kind, and that manual segments are untouched.
const RUN = hasDatabaseUrl();

const wsA = 'a2a20000-0000-0000-0000-00000000000a';
const wsB = 'a2a20000-0000-0000-0000-00000000000b';
const segA = 'a2a20000-0000-0000-0000-0000000000a1';
const segManualA = 'a2a20000-0000-0000-0000-0000000000a2';
const segB = 'a2a20000-0000-0000-0000-0000000000b1';

function deps(admin: Pool): BatchEvalDeps {
  return {
    reader: { query: (text, values) => admin.query(text, values) },
    runInWorkspaceTx: (ws, statements) => runStatementsInWorkspaceTx(admin, ws, statements),
  };
}

async function cleanup(admin: Pool): Promise<void> {
  for (const ws of [wsA, wsB]) {
    await admin.query('DELETE FROM segment_change_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }
}

async function seed(admin: Pool, ws: string, ext: string, total: number): Promise<string> {
  const { rows } = await admin.query(
    'INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$2::text) RETURNING id',
    [ws, ext],
  );
  const id = rows[0].id as string;
  await admin.query(
    'INSERT INTO profile_features (profile_id, workspace_id, total_events) VALUES ($1,$2,$3)',
    [id, ws, total],
  );
  return id;
}

async function members(admin: Pool, ws: string, seg: string): Promise<string[]> {
  const { rows } = await admin.query(
    'SELECT profile_id FROM segment_memberships WHERE workspace_id=$1 AND segment_id=$2 ORDER BY profile_id',
    [ws, seg],
  );
  return rows.map((r) => r.profile_id as string);
}

async function log(admin: Pool, ws: string, seg: string): Promise<string[]> {
  const { rows } = await admin.query(
    'SELECT action FROM segment_change_log WHERE workspace_id=$1 AND segment_id=$2 ORDER BY id',
    [ws, seg],
  );
  return rows.map((r) => r.action as string);
}

describe.skipIf(!RUN)('batch segment sweep on real Postgres (AC Segmentation)', () => {
  let admin: Pool;
  let a1: string;
  let a2: string;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup(admin);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
    await admin.query(
      `INSERT INTO segments (id, workspace_id, name, kind, status, definition)
       VALUES ($1,$2,'batch>=3','dynamic_batch','active',$3::jsonb),
              ($4,$2,'manual','manual','active',NULL),
              ($5,$6,'batch>=3','dynamic_batch','active',$3::jsonb)`,
      [segA, wsA, JSON.stringify({ field: 'total_events', operator: '>=', value: 3 }), segManualA, segB, wsB],
    );
    a1 = await seed(admin, wsA, 'a1', 5); // matches
    a2 = await seed(admin, wsA, 'a2', 1); // below
    await seed(admin, wsB, 'b1', 9); // matches in ws-B
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it('first sweep enters matching profiles (exactly one entered each)', async () => {
    const res = await runBatchEvalForWorkspace(deps(admin), wsA);
    expect(res.segments.find((s) => s.segmentId === segA)).toEqual({ segmentId: segA, entered: 1, exited: 0 });
    expect(await members(admin, wsA, segA)).toEqual([a1]);
    expect(await log(admin, wsA, segA)).toEqual(['entered']);
    // manual segment untouched by the batch evaluator
    expect(await members(admin, wsA, segManualA)).toEqual([]);
  });

  it('re-sweep with no change is idempotent (no duplicate entered)', async () => {
    const res = await runBatchEvalForWorkspace(deps(admin), wsA);
    expect(res.segments.find((s) => s.segmentId === segA)).toEqual({ segmentId: segA, entered: 0, exited: 0 });
    expect(await members(admin, wsA, segA)).toEqual([a1]);
    expect(await log(admin, wsA, segA)).toEqual(['entered']);
  });

  it('a profile crossing the threshold enters; one dropping exits (exactly once)', async () => {
    await admin.query('UPDATE profile_features SET total_events = 4 WHERE profile_id = $1', [a2]); // now matches
    await admin.query('UPDATE profile_features SET total_events = 0 WHERE profile_id = $1', [a1]); // now drops
    const res = await runBatchEvalForWorkspace(deps(admin), wsA);
    expect(res.segments.find((s) => s.segmentId === segA)).toEqual({ segmentId: segA, entered: 1, exited: 1 });
    expect(await members(admin, wsA, segA)).toEqual([a2]);
    expect(await log(admin, wsA, segA)).toEqual(['entered', 'entered', 'exited']);
  });

  it('sweeping ws-A never affects ws-B (workspace_id=$1)', async () => {
    const beforeB = await members(admin, wsB, segB);
    await runBatchEvalForWorkspace(deps(admin), wsA);
    expect(await members(admin, wsB, segB)).toEqual(beforeB); // ws-B untouched by ws-A sweep
  });
});
