import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { enrollFromEvent } from '../src/enroll.js';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

// REAL Postgres. A SINGLE set_attribute node with MULTIPLE assignments (a literal, an
// {{event.*}} expression, AND a sandboxed JS snippet with a {{customer.*}} placeholder)
// writes ALL attributes in ONE nested-jsonb_set UPDATE; the write is workspace-scoped
// + idempotent on a re-tick.
const RUN = hasDatabaseUrl();
const WS = 'b117e570-0000-0000-0000-0000000000a1';
const WS_OTHER = 'b117e570-0000-0000-0000-0000000000a2';
const CAMP = 'b117e570-0000-0000-0000-0000000000c1';

// trigger(event:purchase) -> set_attribute(MULTI: tier=lit, last_amount={{event.amount}},
//   greeting= js snippet over customer.first_name + event.amount) -> exit
const DEF: AutomationDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'event', eventType: 'purchase', label: 'Bought', next: 'm' },
    m: {
      type: 'action',
      kind: 'set_attribute',
      assignments: [
        { key: 'tier', value: { kind: 'literal', value: 'gold' } },
        { key: 'last_amount', value: { kind: 'expression', expression: '{{event.amount}}' } },
        {
          key: 'greeting',
          // JS: reads the in-scope `customer` + `event`, AND a {{customer.*}} placeholder
          // (expanded as a quoted literal before eval).
          value: { kind: 'js', code: 'return "Hi " + {{customer.first_name}} + ", you spent $" + event.amount' },
        },
      ],
      next: 'x',
    } as unknown as AutomationDefinition['nodes'][string],
    x: { type: 'exit' },
  },
};

class CapturingSqs {
  public bodies: string[] = [];
  async send(c: { input?: { MessageBody?: string } }) {
    this.bodies.push(c.input?.MessageBody ?? '');
    return {};
  }
}

describe.skipIf(!RUN)('set_attribute MULTI-assignment (real Postgres)', () => {
  let admin: Pool;
  const NOW = new Date('2026-06-07T12:00:00.000Z');

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const w of [WS, WS_OTHER]) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    }
    await admin.query(
      "INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')",
      [CAMP, WS, JSON.stringify(DEF)],
    );
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

  function runnerDeps(sqs: CapturingSqs): RunDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: sqs as never,
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

  it('writes ALL three attributes in one UPDATE; scoped + idempotent', async () => {
    const email = 'multi@example.com';
    const p = await admin.query(
      'INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,$3::jsonb) RETURNING id',
      [WS, email, JSON.stringify({ first_name: 'jo' })],
    );
    const profileId = p.rows[0].id as string;
    // The SAME email in the other workspace — proves the UPDATE is workspace-scoped.
    const other = await admin.query(
      'INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,$3::jsonb) RETURNING id',
      [WS_OTHER, email, JSON.stringify({ first_name: 'ada' })],
    );
    const otherId = other.rows[0].id as string;

    const res = await enrollFromEvent(enrollDeps(), {
      workspace_id: WS,
      profile_id: profileId,
      type: 'purchase',
      payload: { amount: 42 },
      event_id: 'evt-multi-1',
    });
    expect(res.enrolled).toBe(1);

    const enr = await admin.query<{ id: string }>(
      'SELECT id FROM automation_enrollments WHERE workspace_id = $1 AND automation_id = $2',
      [WS, CAMP],
    );
    const enrollmentId = enr.rows[0]!.id;

    const r1 = await runEnrollment(runnerDeps(new CapturingSqs()), enrollmentId);
    expect(r1.result).toBe('completed');

    const after = await admin.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM profiles WHERE workspace_id = $1 AND id = $2',
      [WS, profileId],
    );
    const attrs = after.rows[0]!.attributes;
    expect(attrs.first_name).toBe('jo'); // preserved
    expect(attrs.tier).toBe('gold'); // literal
    expect(attrs.last_amount).toBe('42'); // {{event.amount}} expression
    expect(attrs.greeting).toBe('Hi jo, you spent $42'); // sandboxed JS over customer + event

    // WORKSPACE-SCOPED: the other tenant's identically-emailed profile is untouched.
    const otherAfter = await admin.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM profiles WHERE workspace_id = $1 AND id = $2',
      [WS_OTHER, otherId],
    );
    expect(otherAfter.rows[0]!.attributes).toEqual({ first_name: 'ada' });

    // IDEMPOTENT: re-arm at start + re-run → identical attributes.
    await admin.query(
      "UPDATE automation_enrollments SET status='active', current_node='t', next_run_at=now() WHERE id=$1",
      [enrollmentId],
    );
    const r2 = await runEnrollment(runnerDeps(new CapturingSqs()), enrollmentId);
    expect(r2.result).toBe('completed');
    const after2 = await admin.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM profiles WHERE workspace_id = $1 AND id = $2',
      [WS, profileId],
    );
    expect(after2.rows[0]!.attributes).toEqual(attrs); // unchanged across the retry
  });
});
