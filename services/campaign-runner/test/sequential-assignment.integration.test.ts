// REAL Postgres. Within ONE Update-profile / Update-journey node the rows apply
// TOP-TO-BOTTOM and a later row can reference a value set by an earlier row in the
// SAME node: row 1 sets `stage`, row 2 reads {{customer.stage}}; row 1 sets a
// journey `cohort`, row 2 reads {{journey.cohort}}. Resolution is sequential (a
// working copy threaded forward); the SQL write is still one nested jsonb_set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { CampaignDefinition } from '../src/dsl.js';

const RUN = hasDatabaseUrl();
const WS = '0c0d0ef6-0000-4000-8000-0000000000a1';
const CAMP_ATTR = '0c0d0ef6-0000-4000-8000-0000000000c1';
const CAMP_JNY = '0c0d0ef6-0000-4000-8000-0000000000c2';

// set_attribute: row1 stage='qualified' (literal) → row2 stage_label uses {{customer.stage}}.
const DEF_ATTR: CampaignDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'a' },
    a: {
      type: 'action',
      kind: 'set_attribute',
      assignments: [
        { key: 'stage', value: { kind: 'literal', value: 'qualified' } },
        { key: 'stage_label', value: { kind: 'expression', expression: 'stage is {{customer.stage}}' } },
      ],
      next: 'x',
    } as unknown as CampaignDefinition['nodes'][string],
    x: { type: 'exit' },
  },
};

// set_journey: row1 cohort='vip' → row2 greeting uses {{journey.cohort}}.
const DEF_JNY: CampaignDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'a' },
    a: {
      type: 'action',
      kind: 'set_journey',
      assignments: [
        { key: 'cohort', value: { kind: 'literal', value: 'vip' } },
        { key: 'greeting', value: { kind: 'expression', expression: 'hi {{journey.cohort}}' } },
      ],
      next: 'x',
    } as unknown as CampaignDefinition['nodes'][string],
    x: { type: 'exit' },
  },
};

class NoopSqs {
  async send() {
    return {};
  }
}

describe.skipIf(!RUN)('sequential in-node assignment dependency (real Postgres)', () => {
  let admin: Pool;
  const NOW = new Date('2026-06-07T12:00:00.000Z');

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await admin.query("INSERT INTO campaigns (id, workspace_id, name, definition, status) VALUES ($1,$2,'A',$3::jsonb,'active')", [CAMP_ATTR, WS, JSON.stringify(DEF_ATTR)]);
    await admin.query("INSERT INTO campaigns (id, workspace_id, name, definition, status) VALUES ($1,$2,'J',$3::jsonb,'active')", [CAMP_JNY, WS, JSON.stringify(DEF_JNY)]);
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
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
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
  async function enroll(campId: string, profileId: string): Promise<string> {
    const r = await admin.query<{ id: string }>(
      `INSERT INTO campaign_enrollments (workspace_id, campaign_id, profile_id, current_node, status, next_run_at)
       VALUES ($1,$2,$3,'t','active', now()) RETURNING id`,
      [WS, campId, profileId],
    );
    return r.rows[0]!.id;
  }

  it('set_attribute: row 2 reads {{customer.stage}} set by row 1', async () => {
    const p = await admin.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,'sa@x.com','{}'::jsonb) RETURNING id", [WS]);
    const profileId = p.rows[0].id as string;
    const enrollmentId = await enroll(CAMP_ATTR, profileId);

    const r1 = await runEnrollment(runnerDeps(), enrollmentId);
    expect(r1.result).toBe('completed');

    const after = await admin.query<{ attributes: Record<string, unknown> }>('SELECT attributes FROM profiles WHERE id=$1', [profileId]);
    expect(after.rows[0]!.attributes.stage).toBe('qualified');
    expect(after.rows[0]!.attributes.stage_label).toBe('stage is qualified'); // saw row 1

    // Idempotent: a re-tick of the completed enrollment doesn't change the value.
    await runEnrollment(runnerDeps(), enrollmentId);
    const again = await admin.query<{ attributes: Record<string, unknown> }>('SELECT attributes FROM profiles WHERE id=$1', [profileId]);
    expect(again.rows[0]!.attributes.stage_label).toBe('stage is qualified');
  });

  it('set_journey: row 2 reads {{journey.cohort}} set by row 1', async () => {
    const p = await admin.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,'sj@x.com','{}'::jsonb) RETURNING id", [WS]);
    const profileId = p.rows[0].id as string;
    const enrollmentId = await enroll(CAMP_JNY, profileId);

    const r1 = await runEnrollment(runnerDeps(), enrollmentId);
    expect(r1.result).toBe('completed');

    const after = await admin.query<{ state: { journey?: Record<string, unknown> } }>('SELECT state FROM campaign_enrollments WHERE id=$1', [enrollmentId]);
    expect(after.rows[0]!.state.journey).toEqual({ cohort: 'vip', greeting: 'hi vip' }); // row 2 saw row 1
  });
});
