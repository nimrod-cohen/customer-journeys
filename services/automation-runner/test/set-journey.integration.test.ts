// REAL Postgres. The `set_journey` action writes per-ENROLLMENT variables onto
// automation_enrollments.state.journey (NOT the global profile), and a downstream
// expression ({{journey.<key>}}) reads them back. Two scenarios keep them apart
// because resolveCtx is loaded once per tick (a same-tick read wouldn't see a
// just-written journey var): (A) set_journey WRITES state.journey from a literal
// + an {{event.*}} expression; (B) a set_attribute READS {{journey.*}} from a
// pre-seeded enrollment state. Workspace-scoped + idempotent on a re-tick.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { enrollFromEvent } from '../src/enroll.js';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

const RUN = hasDatabaseUrl();
const WS = '0c0d0ef4-0000-4000-8000-0000000000a1';
const WS_OTHER = '0c0d0ef4-0000-4000-8000-0000000000a2';
const CAMP_WRITE = '0c0d0ef4-0000-4000-8000-0000000000c1';
const CAMP_READ = '0c0d0ef4-0000-4000-8000-0000000000c2';

// (A) trigger(event:purchase) → set_journey(cohort={{event.plan}}, source='automation') → exit
const DEF_WRITE: AutomationDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'event', eventType: 'purchase', next: 'j' },
    j: {
      type: 'action',
      kind: 'set_journey',
      assignments: [
        { key: 'cohort', value: { kind: 'expression', expression: '{{event.plan}}' } },
        { key: 'source', value: { kind: 'literal', value: 'automation' } },
      ],
      next: 'x',
    } as unknown as AutomationDefinition['nodes'][string],
    x: { type: 'exit' },
  },
};

// (B) trigger(manual) → set_attribute(stamp={{journey.cohort}}) → exit
const DEF_READ: AutomationDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'a' },
    a: {
      type: 'action',
      kind: 'set_attribute',
      assignments: [{ key: 'stamp', value: { kind: 'expression', expression: 'cohort={{journey.cohort}}' } }],
      next: 'x',
    } as unknown as AutomationDefinition['nodes'][string],
    x: { type: 'exit' },
  },
};

class NoopSqs {
  async send() {
    return {};
  }
}

describe.skipIf(!RUN)('set_journey writes + reads enrollment.state.journey (real Postgres)', () => {
  let admin: Pool;
  const NOW = new Date('2026-06-07T12:00:00.000Z');

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const w of [WS, WS_OTHER]) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    }
    await admin.query("INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'CW',$3::jsonb,'active')", [CAMP_WRITE, WS, JSON.stringify(DEF_WRITE)]);
    await admin.query("INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'CR',$3::jsonb,'active')", [CAMP_READ, WS, JSON.stringify(DEF_READ)]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    for (const w of [WS, WS_OTHER]) {
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM automations WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  function runnerDeps(): RunDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: new NoopSqs() as never,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => NOW,
      dispatchQueueUrl: 'q',
    };
  }
  const enrollDeps = () => ({
    reader: { query: (t: string, v?: readonly unknown[]) => admin.query(t, v as unknown[]) } as never,
    runInWorkspaceTx: (w: string, s: never) => runStatementsInWorkspaceTx(admin, w, s),
  });

  it('(A) set_journey stamps state.journey (literal + {{event.*}}), NOT the profile; idempotent', async () => {
    const p = await admin.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,'jw@x.com','{}'::jsonb) RETURNING id", [WS]);
    const profileId = p.rows[0].id as string;
    const res = await enrollFromEvent(enrollDeps(), {
      workspace_id: WS,
      profile_id: profileId,
      type: 'purchase',
      payload: { plan: 'whales' },
      event_id: 'evt-journey-1',
    });
    expect(res.enrolled).toBe(1);
    const enr = await admin.query<{ id: string }>('SELECT id FROM automation_enrollments WHERE workspace_id=$1 AND automation_id=$2', [WS, CAMP_WRITE]);
    const enrollmentId = enr.rows[0]!.id;

    const r1 = await runEnrollment(runnerDeps(), enrollmentId);
    expect(r1.result).toBe('completed');

    const after = await admin.query<{ state: { journey?: Record<string, unknown> } }>(
      'SELECT state FROM automation_enrollments WHERE workspace_id=$1 AND id=$2',
      [WS, enrollmentId],
    );
    expect(after.rows[0]!.state.journey).toEqual({ cohort: 'whales', source: 'automation' });
    // The journey var is per-ENROLLMENT — it must NOT leak onto the profile.
    const prof = await admin.query<{ attributes: Record<string, unknown> }>('SELECT attributes FROM profiles WHERE id=$1', [profileId]);
    expect(prof.rows[0]!.attributes.cohort).toBeUndefined();
  });

  it('(B) a set_attribute reads {{journey.*}} from the persisted enrollment state', async () => {
    const p = await admin.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,'jr@x.com','{}'::jsonb) RETURNING id", [WS]);
    const profileId = p.rows[0].id as string;
    // Seed an enrollment at the start node WITH a journey var already on its state.
    const enr = await admin.query<{ id: string }>(
      `INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at, state)
       VALUES ($1,$2,$3,'t','active', now(), '{"journey":{"cohort":"vip"}}'::jsonb) RETURNING id`,
      [WS, CAMP_READ, profileId],
    );
    const enrollmentId = enr.rows[0]!.id;

    const r1 = await runEnrollment(runnerDeps(), enrollmentId);
    expect(r1.result).toBe('completed');

    const prof = await admin.query<{ attributes: Record<string, unknown> }>('SELECT attributes FROM profiles WHERE id=$1', [profileId]);
    // {{journey.cohort}} resolved from state.journey → written onto the profile.
    expect(prof.rows[0]!.attributes.stamp).toBe('cohort=vip');
  });
});
