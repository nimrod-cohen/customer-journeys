// REAL Postgres: the RICH WAIT-UNTIL through the live runner. Proves the run.ts
// wiring: the condition gate is evaluated (segment-style AST against the profile),
// the time-target/deadline pin is PERSISTED on state.wait.<nodeId> on first
// arrival, the condition is re-checked on each tick (poll), and the max-wait cap
// makes the journey PROCEED on timeout even though the condition stays false.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

const RUN = hasDatabaseUrl();
const WS = '0c0d0ef7-0000-4000-8000-0000000000a1';
const CAMP = '0c0d0ef7-0000-4000-8000-0000000000c1';

// trigger(manual) → wait( condition: attributes.opened exists, maxWait 3 days )
//   → set_attribute(done = 'yes') → exit
const DEF: AutomationDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'w' },
    w: {
      type: 'wait',
      waitCondition: { field: 'attributes.opened', operator: 'exists' },
      maxWait: { amount: 3, unit: 'days' },
      next: 'a',
    } as unknown as AutomationDefinition['nodes'][string],
    a: {
      type: 'action',
      kind: 'set_attribute',
      assignments: [{ key: 'done', value: { kind: 'literal', value: 'yes' } }],
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

describe.skipIf(!RUN)('rich wait-until through the live runner (real Postgres)', () => {
  let admin: Pool;
  let clock = new Date('2026-06-07T12:00:00.000Z');

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await admin.query("INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')", [CAMP, WS, JSON.stringify(DEF)]);
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
      now: () => clock,
      dispatchQueueUrl: 'q',
    };
  }
  async function enroll(profileId: string): Promise<string> {
    const r = await admin.query<{ id: string }>(
      `INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at)
       VALUES ($1,$2,$3,'t','active', now()) RETURNING id`,
      [WS, CAMP, profileId],
    );
    return r.rows[0]!.id;
  }
  const stateOf = async (id: string) =>
    (await admin.query<{ current_node: string; status: string; state: Record<string, unknown> }>(
      'SELECT current_node, status, state FROM automation_enrollments WHERE id=$1',
      [id],
    )).rows[0]!;

  it('condition met before the cap → parks, polls, then advances; pin persisted', async () => {
    const p = await admin.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,'cond@x.com','{}'::jsonb) RETURNING id", [WS]);
    const profileId = p.rows[0].id as string;
    const id = await enroll(profileId);

    // Tick 1: trigger → wait. Condition (opened exists) is FALSE → park at the wait,
    // pin the max-wait deadline (now + 3 days) onto state.wait.w.
    clock = new Date('2026-06-07T12:00:00.000Z');
    const r1 = await runEnrollment(deps(), id);
    expect(r1.result).toBe('parked');
    const s1 = await stateOf(id);
    expect(s1.current_node).toBe('w');
    expect(s1.status).toBe('active');
    const pin = (s1.state.wait as Record<string, { deadline: string; target: string | null }>).w;
    expect(pin.deadline).toBe('2026-06-10T12:00:00.000Z');
    expect(pin.target).toBeNull();

    // Tick 2 (a day later): condition still FALSE → stays parked.
    clock = new Date('2026-06-08T12:00:00.000Z');
    const r2 = await runEnrollment(deps(), id);
    expect(r2.result).toBe('parked');
    expect((await stateOf(id)).current_node).toBe('w');

    // The profile opens → condition becomes TRUE.
    await admin.query("UPDATE profiles SET attributes = attributes || '{\"opened\":true}'::jsonb WHERE id=$1", [profileId]);

    // Tick 3 (still before the cap): condition met → advance through set_attribute → exit.
    clock = new Date('2026-06-09T12:00:00.000Z');
    const r3 = await runEnrollment(deps(), id);
    expect(r3.result).toBe('completed');
    const after = await admin.query<{ attributes: Record<string, unknown> }>('SELECT attributes FROM profiles WHERE id=$1', [profileId]);
    expect(after.rows[0]!.attributes.done).toBe('yes');
  });

  it('condition NEVER met → PROCEEDS on the max-wait timeout (proceed-on-timeout)', async () => {
    const p = await admin.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,'timeout@x.com','{}'::jsonb) RETURNING id", [WS]);
    const profileId = p.rows[0].id as string;
    const id = await enroll(profileId);

    // Tick 1: park at the wait, pin deadline now+3d.
    clock = new Date('2026-06-07T12:00:00.000Z');
    expect((await runEnrollment(deps(), id)).result).toBe('parked');

    // Tick 2 AFTER the 3-day cap, condition STILL false → advance anyway → complete.
    clock = new Date('2026-06-11T12:00:00.000Z');
    const r2 = await runEnrollment(deps(), id);
    expect(r2.result).toBe('completed');
    const after = await admin.query<{ attributes: Record<string, unknown> }>('SELECT attributes FROM profiles WHERE id=$1', [profileId]);
    expect(after.rows[0]!.attributes.done).toBe('yes'); // the set_attribute ran on timeout
    expect(after.rows[0]!.attributes.opened).toBeUndefined();
  });
});
