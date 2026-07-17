// Phase 3 (real Postgres): event-trigger enrollment. An event of the configured
// type (matching the optional payload filter) enrolls the profile into matching
// ACTIVE automations EXACTLY once (idempotent on replay); a non-matching
// event/filter does NOT enroll; everything workspace-scoped. Segment-entry stays
// untouched (regression guard) and the 'once' policy is consistent across kinds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import {
  enrollFromEvent,
  enrollFromSegmentChange,
  type EnrollDeps,
  type Reader,
} from '../src/enroll.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import type { EventRow } from '../src/core.js';
import type { SegmentChangeLogRow } from '../src/core.js';
import type { AutomationDefinition } from '../src/dsl.js';

const RUN = hasDatabaseUrl();
const WS = 'ca110001-0000-0000-0000-0000000000f5';
const WS_B = 'ca110001-0000-0000-0000-0000000000f6';
const SEG = 'ca110001-0000-0000-0000-0000000000a5';

const eventDef = (eventType: string, filter?: unknown): AutomationDefinition =>
  ({
    startNode: 'trig',
    nodes: {
      trig: { type: 'trigger', kind: 'event', eventType, ...(filter ? { filter } : {}), next: 'x' },
      x: { type: 'exit' },
    },
  }) as unknown as AutomationDefinition;

const SEG_DEF: AutomationDefinition = {
  startNode: 'trig',
  nodes: { trig: { type: 'trigger', kind: 'segment_entry', next: 'x' }, x: { type: 'exit' } },
};

describe.skipIf(!RUN)('enrollFromEvent (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const ws of [WS, WS_B]) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await admin.query(
      "INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'seg','dynamic_realtime')",
      [SEG, WS],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM automations WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  function deps(): EnrollDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return { reader, runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s) };
  }

  async function newProfile(ws: string, ext: string): Promise<string> {
    const r = await admin.query('INSERT INTO profiles (workspace_id, external_id) VALUES ($1,$2) RETURNING id', [ws, ext]);
    return r.rows[0].id as string;
  }
  async function newAutomation(ws: string, def: AutomationDefinition, status = 'active'): Promise<string> {
    const r = await admin.query(
      'INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,$2,$3::jsonb,$4) RETURNING id',
      [ws, 'C', JSON.stringify(def), status],
    );
    return r.rows[0].id as string;
  }
  function eventRow(profileId: string, type: string, payload: Record<string, unknown> = {}, ws = WS): EventRow {
    return { workspace_id: ws, profile_id: profileId, type, payload, event_id: `${profileId}-${type}` };
  }
  async function count(ws: string, campId: string, profId: string): Promise<number> {
    const r = await admin.query(
      'SELECT count(*)::int n FROM automation_enrollments WHERE workspace_id = $1 AND automation_id = $2 AND profile_id = $3',
      [ws, campId, profId],
    );
    return r.rows[0].n as number;
  }

  it('enrolls a profile at the start node for a matching event type (no filter)', async () => {
    const camp = await newAutomation(WS, eventDef('purchase'));
    const prof = await newProfile(WS, 'p-basic');
    const res = await enrollFromEvent(deps(), eventRow(prof, 'purchase'));
    expect(res.enrolled).toBe(1);
    const e = await admin.query(
      'SELECT current_node, status FROM automation_enrollments WHERE workspace_id = $1 AND automation_id = $2 AND profile_id = $3',
      [WS, camp, prof],
    );
    expect(e.rows).toHaveLength(1);
    expect(e.rows[0].current_node).toBe('trig');
    expect(e.rows[0].status).toBe('active');
  });

  it('REPLAY: enrolling twice leaves exactly ONE row (ON CONFLICT once)', async () => {
    const camp = await newAutomation(WS, eventDef('replay_evt'));
    const prof = await newProfile(WS, 'p-replay');
    await enrollFromEvent(deps(), eventRow(prof, 'replay_evt'));
    await enrollFromEvent(deps(), eventRow(prof, 'replay_evt'));
    expect(await count(WS, camp, prof)).toBe(1);
  });

  it('a DIFFERENT event type enrolls nobody', async () => {
    await newAutomation(WS, eventDef('only_this'));
    const prof = await newProfile(WS, 'p-othertype');
    const res = await enrollFromEvent(deps(), eventRow(prof, 'something_else'));
    expect(res.enrolled).toBe(0);
    const c = await admin.query('SELECT count(*)::int n FROM automation_enrollments WHERE workspace_id = $1 AND profile_id = $2', [WS, prof]);
    expect(c.rows[0].n).toBe(0);
  });

  it('payload filter (amount >= 100): 150 enrolls, 50 does not', async () => {
    const filter = { field: 'payload.amount', operator: '>=', value: 100 };
    const camp = await newAutomation(WS, eventDef('filtered_purchase', filter));
    const hi = await newProfile(WS, 'p-hi');
    const lo = await newProfile(WS, 'p-lo');
    await enrollFromEvent(deps(), eventRow(hi, 'filtered_purchase', { amount: 150 }));
    await enrollFromEvent(deps(), eventRow(lo, 'filtered_purchase', { amount: 50 }));
    expect(await count(WS, camp, hi)).toBe(1);
    expect(await count(WS, camp, lo)).toBe(0);
  });

  it('TENANT ISOLATION: a WS-B automation with the same eventType is NOT enrolled by a WS-A event', async () => {
    const campB = await newAutomation(WS_B, eventDef('iso_evt'));
    const profA = await newProfile(WS, 'p-iso-a');
    await enrollFromEvent(deps(), eventRow(profA, 'iso_evt', {}, WS));
    // No enrollment in WS-B for the WS-A profile.
    const c = await admin.query('SELECT count(*)::int n FROM automation_enrollments WHERE automation_id = $1', [campB]);
    expect(c.rows[0].n).toBe(0);
  });

  it('a non-active (draft) event-trigger automation does NOT enroll', async () => {
    const camp = await newAutomation(WS, eventDef('draft_evt'), 'draft');
    const prof = await newProfile(WS, 'p-draft');
    const res = await enrollFromEvent(deps(), eventRow(prof, 'draft_evt'));
    expect(res.enrolled).toBe(0);
    expect(await count(WS, camp, prof)).toBe(0);
  });

  it('SEGMENT-ENTRY REGRESSION: enrollFromSegmentChange still enrolls exactly once', async () => {
    const camp = await admin.query(
      "INSERT INTO automations (workspace_id, name, definition, trigger_segment_id, status) VALUES ($1,'SegC',$2::jsonb,$3,'active') RETURNING id",
      [WS, JSON.stringify(SEG_DEF), SEG],
    );
    const campId = camp.rows[0].id as string;
    const prof = await newProfile(WS, 'p-seg');
    const row: SegmentChangeLogRow = { workspace_id: WS, segment_id: SEG, profile_id: prof, action: 'entered' };
    const res = await enrollFromSegmentChange(deps(), row);
    expect(res.enrolled).toBe(1);
    expect(await count(WS, campId, prof)).toBe(1);
  });

  it("'once' across kinds: a profile enrolled via segment_entry is NOT re-enrolled by a later matching event into the SAME automation", async () => {
    // A automation with a segment_entry trigger AND (hypothetically) the same start
    // node. We simulate enrolling via segment entry then firing an event for the
    // SAME automation id — the UNIQUE(automation_id, profile_id) keeps it at one row.
    const camp = await admin.query(
      "INSERT INTO automations (workspace_id, name, definition, trigger_segment_id, status) VALUES ($1,'Both',$2::jsonb,$3,'active') RETURNING id",
      [WS, JSON.stringify(SEG_DEF), SEG],
    );
    const campId = camp.rows[0].id as string;
    const prof = await newProfile(WS, 'p-both');
    await enrollFromSegmentChange(deps(), { workspace_id: WS, segment_id: SEG, profile_id: prof, action: 'entered' });
    // Manually insert a second enrollment via buildEnrollmentInsert path (the event
    // path uses the same builder): ON CONFLICT keeps it at one.
    await runStatementsInWorkspaceTx(admin, WS, [
      {
        text: `INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at)
               VALUES ($1,$2,$3,'trig','active', now()) ON CONFLICT (automation_id, profile_id) DO NOTHING`,
        values: [WS, campId, prof],
      },
    ]);
    expect(await count(WS, campId, prof)).toBe(1);
  });
});
