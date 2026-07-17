// REAL Postgres: a AUTOMATION IF can branch on a JOURNEY attribute (a per-enrollment
// variable set by an Update-journey step). The journey leaf lives on the enrollment
// state (not the profile), so the runner evaluates it IN-MEMORY against state.journey
// and folds it to a constant BEFORE the segment SQL. A set_journey then IF in the SAME
// tick sees the just-set value (tick-local journey threading).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

const RUN = hasDatabaseUrl();
const WS = '0c0d0ef8-0000-4000-8000-0000000000a1';
const CAMP_YES = '0c0d0ef8-0000-4000-8000-0000000000c1'; // condition value matches → Yes
const CAMP_NO = '0c0d0ef8-0000-4000-8000-0000000000c2'; // condition value differs → No

// trigger(manual) → set_journey(day='saturday') → if(journey.day = <value>) →
//   Yes: set_attribute(result='yes') → exit ; No: set_attribute(result='no') → exit
const def = (conditionValue: string): AutomationDefinition => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'sj' },
    sj: {
      type: 'action',
      kind: 'set_journey',
      assignments: [{ key: 'day', value: { kind: 'literal', value: 'saturday' } }],
      next: 'c',
    } as unknown as AutomationDefinition['nodes'][string],
    c: {
      type: 'condition',
      ast: { journeyKey: 'day', operator: '=', value: conditionValue },
      onTrue: 'y',
      onFalse: 'n',
    } as unknown as AutomationDefinition['nodes'][string],
    y: {
      type: 'action',
      kind: 'set_attribute',
      assignments: [{ key: 'result', value: { kind: 'literal', value: 'yes' } }],
      next: 'x',
    } as unknown as AutomationDefinition['nodes'][string],
    n: {
      type: 'action',
      kind: 'set_attribute',
      assignments: [{ key: 'result', value: { kind: 'literal', value: 'no' } }],
      next: 'x',
    } as unknown as AutomationDefinition['nodes'][string],
    x: { type: 'exit' },
  },
});

class NoopSqs {
  async send() {
    return {};
  }
}

describe.skipIf(!RUN)('automation IF branches on a journey attribute (real Postgres)', () => {
  let admin: Pool;
  const NOW = new Date('2026-06-07T12:00:00.000Z');

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await admin.query("INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'Yes',$3::jsonb,'active')", [CAMP_YES, WS, JSON.stringify(def('saturday'))]);
    await admin.query("INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'No',$3::jsonb,'active')", [CAMP_NO, WS, JSON.stringify(def('sunday'))]);
  });
  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });
  async function cleanup() {
    await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM automations WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }
  function deps(): RunDeps {
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
  async function enroll(campId: string, email: string): Promise<{ id: string; profileId: string }> {
    const p = await admin.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,'{}'::jsonb) RETURNING id", [WS, email]);
    const profileId = p.rows[0].id as string;
    const r = await admin.query<{ id: string }>(
      `INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at)
       VALUES ($1,$2,$3,'t','active', now()) RETURNING id`,
      [WS, campId, profileId],
    );
    return { id: r.rows[0]!.id, profileId };
  }
  const resultOf = async (profileId: string) =>
    (await admin.query<{ attributes: Record<string, unknown> }>('SELECT attributes FROM profiles WHERE id=$1', [profileId])).rows[0]!.attributes.result;

  it('a set_journey in the SAME tick is visible to the IF → takes the Yes branch', async () => {
    const { id, profileId } = await enroll(CAMP_YES, 'yes@x.com');
    const r = await runEnrollment(deps(), id);
    expect(r.result).toBe('completed');
    expect(await resultOf(profileId)).toBe('yes'); // journey.day='saturday' === 'saturday'
  });

  it('a non-matching journey value takes the No branch', async () => {
    const { id, profileId } = await enroll(CAMP_NO, 'no@x.com');
    const r = await runEnrollment(deps(), id);
    expect(r.result).toBe('completed');
    expect(await resultOf(profileId)).toBe('no'); // journey.day='saturday' !== 'sunday'
  });
});
