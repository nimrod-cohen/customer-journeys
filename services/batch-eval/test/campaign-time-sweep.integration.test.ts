import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runCampaignTimeSweepForWorkspace, type BatchEvalDeps } from '../src/core.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// Phase 4a: the scheduled sweep re-evaluates TIME-SENSITIVE segments that trigger
// active campaigns and emits enter/exit transitions, so membership drifts with the
// clock (a profile ages out of a window with no new event). It must:
//   - ADD a profile that now matches (entered + membership), even with no row,
//   - REMOVE a profile that aged out of the window (exited + membership delete),
//   - SKIP non-time-sensitive trigger segments (the processor owns those).
const RUN = hasDatabaseUrl();
const ws = 'a2a2cafe-0000-0000-0000-0000000000a1';
const segRecent = 'a2a2cafe-0000-0000-0000-0000000000d1'; // login within 7 days (time-sensitive)
const segVip = 'a2a2cafe-0000-0000-0000-0000000000d2'; // tier=vip (NOT time-sensitive)

function deps(admin: Pool): BatchEvalDeps {
  return {
    reader: { query: (text, values) => admin.query(text, values) },
    runInWorkspaceTx: (w, statements) => runStatementsInWorkspaceTx(admin, w, statements),
  };
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM segment_change_log WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
}

describe.skipIf(!RUN)('campaign time-sensitive segment sweep (real Postgres)', () => {
  let admin: Pool;
  let pFresh = '';
  let pAged = '';

  beforeAll(async () => {
    admin = adminPool();
    await cleanup(admin);
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    const mk = async (ext: string, tier: string, loginDaysAgo: number) => {
      const r = await admin.query(
        `INSERT INTO profiles (workspace_id, external_id, attributes) VALUES ($1,$2, jsonb_build_object('tier',$3::text)) RETURNING id`,
        [ws, ext, tier],
      );
      const pid = r.rows[0].id;
      await admin.query(
        `INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload)
         VALUES (gen_random_uuid(),$1,$2,'login', now() - ($3::int * interval '1 day'), '{}'::jsonb)`,
        [ws, pid, loginDaysAgo],
      );
      return pid;
    };
    pFresh = await mk('fresh', 'vip', 3); // logged in 3 days ago → within 7
    pAged = await mk('aged', 'vip', 10); // logged in 10 days ago → outside 7
    // Time-sensitive segment + an active campaign that triggers on it.
    await admin.query(
      `INSERT INTO segments (id, workspace_id, name, kind, status, definition)
       VALUES ($1,$2,'recent login','dynamic_realtime','active',$3::jsonb)`,
      [segRecent, ws, JSON.stringify({ event: 'login', withinDays: 7 })],
    );
    // A non-time-sensitive segment + campaign (must be skipped by the sweep).
    await admin.query(
      `INSERT INTO segments (id, workspace_id, name, kind, status, definition)
       VALUES ($1,$2,'vips','dynamic_realtime','active',$3::jsonb)`,
      [segVip, ws, JSON.stringify({ field: 'attributes.tier', operator: '=', value: 'vip' })],
    );
    await admin.query(
      `INSERT INTO campaigns (workspace_id, name, definition, trigger_segment_id, status)
       VALUES ($1,'recent-camp','{}'::jsonb,$2,'active'),($1,'vip-camp','{}'::jsonb,$3,'active')`,
      [ws, segRecent, segVip],
    );
    // STALE membership: pAged was materialized into 'recent login' when fresh.
    await admin.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'evaluator')",
      [segRecent, pAged, ws],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  async function members(seg: string): Promise<string[]> {
    const r = await admin.query(
      "SELECT profile_id FROM segment_memberships WHERE workspace_id=$1 AND segment_id=$2 ORDER BY profile_id",
      [ws, seg],
    );
    return r.rows.map((x) => x.profile_id);
  }
  async function changeLog(seg: string): Promise<Array<{ profile_id: string; action: string }>> {
    const r = await admin.query(
      'SELECT profile_id, action FROM segment_change_log WHERE workspace_id=$1 AND segment_id=$2 ORDER BY action',
      [ws, seg],
    );
    return r.rows as Array<{ profile_id: string; action: string }>;
  }

  it('admits the fresh matcher, exits the aged-out one, and skips the non-time segment', async () => {
    const res = await runCampaignTimeSweepForWorkspace(deps(admin), ws);

    // Only the time-sensitive segment was swept.
    expect(res.segments.map((s) => s.segmentId)).toEqual([segRecent]);

    // recent login now contains ONLY pFresh (pAged aged out).
    expect(await members(segRecent)).toEqual([pFresh]);

    const log = await changeLog(segRecent);
    expect(log).toContainEqual({ profile_id: pFresh, action: 'entered' });
    expect(log).toContainEqual({ profile_id: pAged, action: 'exited' });

    // The non-time-sensitive 'vips' segment was NOT swept (no membership/log written).
    expect(await members(segVip)).toEqual([]);
    expect(await changeLog(segVip)).toEqual([]);
  });

  it('is idempotent — a second sweep makes no further changes', async () => {
    const res = await runCampaignTimeSweepForWorkspace(deps(admin), ws);
    expect(res.segments).toEqual([{ segmentId: segRecent, entered: 0, exited: 0 }]);
    expect(await members(segRecent)).toEqual([pFresh]);
  });
});
