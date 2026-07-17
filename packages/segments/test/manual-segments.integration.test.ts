import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import {
  addManualMembers,
  removeManualMembers,
  resolveAudience,
  buildInsertMemberships,
  buildDeleteMemberships,
  evaluateRealtimeSegmentsForProfile,
  type EvaluateDeps,
  type SqlStatement,
} from '../src/index.js';

// AC "Segments" / "Broadcasts" on REAL Postgres (§8, §18). Proves:
//  - manual segments change ONLY via user edit and are NOT touched by the evaluator
//  - both kinds (dynamic + manual) resolve as audiences
//  - the evaluator's source='evaluator' deletes never remove a manual membership
const RUN = hasDatabaseUrl();

const ws = 'e6e60000-0000-0000-0000-000000000001';
const segDyn = 'e6e60000-0000-0000-0000-0000000000d1';
const segManual = 'e6e60000-0000-0000-0000-0000000000c1';

function deps(admin: Pool): EvaluateDeps {
  return {
    reader: { query: (text, values) => admin.query(text, values) },
    runInWorkspaceTx: async (_ws: string, statements: readonly SqlStatement[]) => {
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        for (const s of statements) await c.query(s.text, s.values);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  };
}

async function run(admin: Pool, s: SqlStatement): Promise<void> {
  await admin.query(s.text, s.values);
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM segment_change_log WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
}

async function seedProfile(admin: Pool, ext: string, total: number): Promise<string> {
  const { rows } = await admin.query(
    "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$2||'@test.local') RETURNING id",
    [ws, ext],
  );
  const id = rows[0].id as string;
  await admin.query(
    'INSERT INTO profile_features (profile_id, workspace_id, total_events) VALUES ($1,$2,$3)',
    [id, ws, total],
  );
  return id;
}

async function audienceIds(admin: Pool, segId: string): Promise<string[]> {
  const q = resolveAudience(ws, segId);
  const { rows } = await admin.query(q.text, q.values);
  return rows.map((r) => r.profile_id as string).sort();
}

describe.skipIf(!RUN)('manual segments on real Postgres (AC Segments)', () => {
  let admin: Pool;
  let pm1: string;
  let pm2: string;
  let pd1: string;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup(admin);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'M')", [ws]);
    await admin.query(
      `INSERT INTO segments (id, workspace_id, name, kind, status, definition)
       VALUES ($1,$2,'manual','manual','active',NULL),
              ($3,$2,'dyn','dynamic_realtime','active',$4::jsonb)`,
      [segManual, ws, segDyn, JSON.stringify({ field: 'total_events', operator: '>=', value: 3 })],
    );
    pm1 = await seedProfile(admin, 'm1', 0);
    pm2 = await seedProfile(admin, 'm2', 0);
    pd1 = await seedProfile(admin, 'd1', 5); // matches the dynamic rule
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it('addManualMembers / removeManualMembers change membership only via user edit', async () => {
    await run(admin, addManualMembers(ws, segManual, [pm1, pm2]));
    expect(await audienceIds(admin, segManual)).toEqual([pm1, pm2].sort());

    // idempotent re-add (ON CONFLICT DO NOTHING)
    await run(admin, addManualMembers(ws, segManual, [pm1]));
    expect(await audienceIds(admin, segManual)).toEqual([pm1, pm2].sort());

    await run(admin, removeManualMembers(ws, segManual, [pm1]));
    expect(await audienceIds(admin, segManual)).toEqual([pm2]);
  });

  it('the evaluator never adds/removes rows on a manual segment', async () => {
    // Evaluate pm2 (total=0, would NOT match the dynamic rule anyway). The manual
    // segment is kind='manual' so it is never selected by the realtime evaluator.
    const before = await audienceIds(admin, segManual);
    await evaluateRealtimeSegmentsForProfile(deps(admin), ws, pm2);
    expect(await audienceIds(admin, segManual)).toEqual(before); // unchanged
  });

  it("evaluator's source='evaluator' delete cannot remove a manual membership", async () => {
    // Put pd1 into the MANUAL segment by hand AND let the evaluator add it to the
    // dynamic segment. Then run an evaluator delete for the manual segment id with
    // pd1 — it must NOT remove the manual row (source mismatch).
    await run(admin, addManualMembers(ws, segManual, [pd1]));
    await run(admin, buildInsertMemberships(ws, segManual, [pd1])); // (no-op: conflict)

    // An evaluator-scoped delete targeting the manual row:
    await run(admin, buildDeleteMemberships(ws, segManual, [pd1]));
    // pd1 still present in manual (source='manual' was protected)
    const ids = await audienceIds(admin, segManual);
    expect(ids).toContain(pd1);
  });

  it('both kinds resolve as audiences', async () => {
    await evaluateRealtimeSegmentsForProfile(deps(admin), ws, pd1); // enters dynamic
    expect(await audienceIds(admin, segDyn)).toContain(pd1);
    expect((await audienceIds(admin, segManual)).length).toBeGreaterThan(0);
  });
});
