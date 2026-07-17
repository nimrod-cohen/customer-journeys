import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { buildSweepQuery } from '../src/core.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

// §9B AC: an enrolled profile advances trigger→wait→condition→action→exit; a
// wait defers until next_run_at; a branch routes; sends pass through the
// Dispatcher (here we assert outbox rows are produced; the dispatcher chain has
// its own test). Real Postgres on adminPool; SQS captured. File-local UUIDs.
const RUN = hasDatabaseUrl();
const WS = 'ca110000-0000-0000-0000-0000000000f1';
const CAMP = 'ca110000-0000-0000-0000-0000000000c1';
const PROF = 'ca110000-0000-0000-0000-0000000000d1';
const TPL = 'ca110000-0000-0000-0000-0000000000e1';

const DEF: AutomationDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'w' },
    w: { type: 'wait', delay: { seconds: 3600 }, next: 'c' },
    c: {
      type: 'condition',
      ast: { field: 'total_events', operator: '>=', value: 1 },
      onTrue: 'a',
      onFalse: 'x',
    },
    a: { type: 'action', kind: 'send', template_id: TPL, next: 'x' },
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

describe.skipIf(!RUN)('automation full lifecycle (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query(
      "INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')",
      [WS],
    );
    await admin.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<h/>')",
      [TPL, WS],
    );
    await admin.query(
      'INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,$3,$4)',
      [PROF, WS, 'ext-1', 'lc@example.com'],
    );
    await admin.query(
      "INSERT INTO profile_features (profile_id, workspace_id, total_events) VALUES ($1,$2,5)",
      [PROF, WS],
    );
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
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM automations WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  function makeDeps(now: Date, sqs: CapturingSqs): RunDeps {
    const reader: Reader = {
      query: (text, values) => admin.query(text, values as unknown[]) as never,
    };
    return {
      reader,
      sqs: sqs as never,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => now,
      dispatchQueueUrl: 'https://sqs/dispatch',
    };
  }

  it('runs the full journey across two ticks (wait, then branch→send→exit)', async () => {
    // Enroll at the trigger (next_run_at now so the first sweep picks it up).
    const enr = await admin.query(
      "INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now()) RETURNING id",
      [WS, CAMP, PROF],
    );
    const enrollmentId = enr.rows[0].id;

    // Tick 1 @ T0: trigger → wait → PARK at wait (next_run_at = T0 + 1h).
    const t0 = new Date('2026-06-07T12:00:00.000Z');
    const sqs1 = new CapturingSqs();
    const r1 = await runEnrollment(makeDeps(t0, sqs1), enrollmentId);
    expect(r1.result).toBe('parked');
    expect((r1 as { node: string }).node).toBe('w');
    expect(sqs1.bodies).toHaveLength(0);

    // The sweep at T0 should NOT pick the row again (next_run_at is in the future).
    const sweepEarly = buildSweepQuery(t0);
    const due0 = await admin.query(sweepEarly.text, sweepEarly.values);
    expect(due0.rows.find((x) => x.id === enrollmentId)).toBeUndefined();

    // Tick 2 @ T0 + 2h: the wait has elapsed → condition(true)→send→exit.
    const t2 = new Date('2026-06-07T14:00:00.000Z');
    const sweepLate = buildSweepQuery(t2);
    const due2 = await admin.query(sweepLate.text, sweepLate.values);
    expect(due2.rows.find((x) => x.id === enrollmentId)).toBeDefined();

    const sqs2 = new CapturingSqs();
    const r2 = await runEnrollment(makeDeps(t2, sqs2), enrollmentId);
    expect(r2.result).toBe('completed');
    // exactly one send enqueued; one outbox row created for this automation+node.
    expect(sqs2.bodies).toHaveLength(1);

    const ob = await admin.query(
      'SELECT id, automation_id, dedupe_key FROM outbox WHERE workspace_id = $1',
      [WS],
    );
    expect(ob.rows).toHaveLength(1);
    expect(ob.rows[0].automation_id).toBe(CAMP);
    expect(ob.rows[0].dedupe_key).toBe(`automation:${CAMP}:${PROF}:a`);

    const fin = await admin.query(
      'SELECT status FROM automation_enrollments WHERE id = $1',
      [enrollmentId],
    );
    expect(fin.rows[0].status).toBe('completed');
  });
});
