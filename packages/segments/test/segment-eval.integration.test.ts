import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import {
  evaluateRealtimeSegmentsForProfile,
  type EvaluateDeps,
  type SqlStatement,
} from '../src/index.js';

// AC "Segmentation" on REAL Postgres (§8, §18). Proves enter-once / exit-once and
// cross-workspace isolation. The evaluator runs as the SERVICE ROLE (bypasses
// RLS) on the admin pool — isolation is in-code workspace_id=$1 scoping (mirrors
// services/processor/test/workspace-isolation.integration.test.ts).
const RUN = hasDatabaseUrl();

// File-local UUID namespace + event_id namespace (global event_id PK).
const wsA = 'e5e50000-0000-0000-0000-00000000000a';
const wsB = 'e5e50000-0000-0000-0000-00000000000b';
const segA = 'e5e50000-0000-0000-0000-0000000000a1';
const segManualA = 'e5e50000-0000-0000-0000-0000000000a2';
const segB = 'e5e50000-0000-0000-0000-0000000000b1';

function deps(admin: Pool): EvaluateDeps {
  return {
    reader: { query: (text, values) => admin.query(text, values) },
    runInWorkspaceTx: async (workspaceId: string, statements: readonly SqlStatement[]) => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        for (const s of statements) await client.query(s.text, s.values);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
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

/** Insert a profile + feature row; returns the profile id. */
async function seedProfile(
  admin: Pool,
  ws: string,
  externalId: string,
  totalEvents: number,
  attributes: Record<string, unknown> = {},
): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO profiles (workspace_id, external_id, attributes)
     VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [ws, externalId, JSON.stringify(attributes)],
  );
  const id = rows[0].id as string;
  await admin.query(
    `INSERT INTO profile_features (profile_id, workspace_id, total_events)
     VALUES ($1, $2, $3)`,
    [id, ws, totalEvents],
  );
  return id;
}

async function setTotalEvents(admin: Pool, profileId: string, n: number): Promise<void> {
  await admin.query('UPDATE profile_features SET total_events = $2 WHERE profile_id = $1', [
    profileId,
    n,
  ]);
}

async function changeLog(admin: Pool, ws: string, seg: string): Promise<string[]> {
  const { rows } = await admin.query(
    'SELECT action FROM segment_change_log WHERE workspace_id = $1 AND segment_id = $2 ORDER BY id',
    [ws, seg],
  );
  return rows.map((r) => r.action as string);
}

async function memberCount(admin: Pool, ws: string, seg: string, source?: string): Promise<number> {
  const { rows } = source
    ? await admin.query(
        'SELECT count(*)::int n FROM segment_memberships WHERE workspace_id=$1 AND segment_id=$2 AND source=$3',
        [ws, seg, source],
      )
    : await admin.query(
        'SELECT count(*)::int n FROM segment_memberships WHERE workspace_id=$1 AND segment_id=$2',
        [ws, seg],
      );
  return rows[0].n as number;
}

describe.skipIf(!RUN)('realtime segment evaluation on real Postgres (AC Segmentation)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup(admin);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
    // ws-A: a dynamic_realtime segment "total_events >= 3"
    await admin.query(
      `INSERT INTO segments (id, workspace_id, name, kind, status, definition)
       VALUES ($1,$2,'>=3','dynamic_realtime','active',$3::jsonb)`,
      [segA, wsA, JSON.stringify({ field: 'total_events', operator: '>=', value: 3 })],
    );
    // ws-A: a MANUAL segment (must be ignored by the evaluator)
    await admin.query(
      `INSERT INTO segments (id, workspace_id, name, kind, status, definition)
       VALUES ($1,$2,'manual','manual','active',NULL)`,
      [segManualA, wsA],
    );
    // ws-B: an IDENTICAL realtime rule, isolated workspace
    await admin.query(
      `INSERT INTO segments (id, workspace_id, name, kind, status, definition)
       VALUES ($1,$2,'>=3','dynamic_realtime','active',$3::jsonb)`,
      [segB, wsB, JSON.stringify({ field: 'total_events', operator: '>=', value: 3 })],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it('crossing the predicate yields exactly ONE entered; membership added', async () => {
    const p = await seedProfile(admin, wsA, 'cross-1', 2); // below threshold
    // below threshold → no change
    let res = await evaluateRealtimeSegmentsForProfile(deps(admin), wsA, p);
    expect(res.deltas.find((d) => d.segmentId === segA)!.action).toBe('none');
    expect(await memberCount(admin, wsA, segA)).toBe(0);

    // cross the predicate
    await setTotalEvents(admin, p, 3);
    res = await evaluateRealtimeSegmentsForProfile(deps(admin), wsA, p);
    expect(res.deltas.find((d) => d.segmentId === segA)!.action).toBe('entered');
    expect(await memberCount(admin, wsA, segA)).toBe(1);
    expect(await changeLog(admin, wsA, segA)).toEqual(['entered']);

    // re-eval while STILL matching → idempotent, no second 'entered'
    res = await evaluateRealtimeSegmentsForProfile(deps(admin), wsA, p);
    expect(res.deltas.find((d) => d.segmentId === segA)!.action).toBe('none');
    expect(await changeLog(admin, wsA, segA)).toEqual(['entered']);

    // drop back below → exactly ONE exited
    await setTotalEvents(admin, p, 1);
    res = await evaluateRealtimeSegmentsForProfile(deps(admin), wsA, p);
    expect(res.deltas.find((d) => d.segmentId === segA)!.action).toBe('exited');
    expect(await memberCount(admin, wsA, segA)).toBe(0);
    expect(await changeLog(admin, wsA, segA)).toEqual(['entered', 'exited']);
  });

  it('the evaluator NEVER evaluates a manual segment (no membership written)', async () => {
    const p = await seedProfile(admin, wsA, 'manual-skip', 99);
    await evaluateRealtimeSegmentsForProfile(deps(admin), wsA, p);
    // segA matched (99>=3) → 1 evaluator member; manual segment untouched.
    expect(await memberCount(admin, wsA, segManualA)).toBe(0);
  });

  it('cross-workspace: evaluating ws-A NEVER matches/affects ws-B profiles', async () => {
    // a ws-B profile well over threshold
    const pB = await seedProfile(admin, wsB, 'b-cust', 50);
    // Evaluate it under ws-B → enters ws-B's segment.
    await evaluateRealtimeSegmentsForProfile(deps(admin), wsB, pB);
    expect(await memberCount(admin, wsB, segB)).toBe(1);

    // Now (mis)evaluate the SAME ws-B profile under ws-A scoping: the match query
    // is `p.workspace_id = $1 AND p.id = $profile`, so a ws-B profile can never
    // match under ws-A — nothing changes in ws-A and ws-B membership is untouched.
    const before = await memberCount(admin, wsA, segA);
    const res = await evaluateRealtimeSegmentsForProfile(deps(admin), wsA, pB);
    expect(res.deltas.every((d) => d.action === 'none')).toBe(true);
    expect(await memberCount(admin, wsA, segA)).toBe(before);
    expect(await memberCount(admin, wsB, segB)).toBe(1); // ws-B unchanged
  });
});
