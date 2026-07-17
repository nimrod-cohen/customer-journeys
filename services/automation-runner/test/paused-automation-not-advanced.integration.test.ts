import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

// §9B phase 7: PAUSE halts advancement. The runner re-checks automations.status
// INSIDE the locked tick (FOR UPDATE on the enrollment + the automation read) and
// advances ONLY when status='active'. A paused automation's DUE enrollment is left
// parked exactly where it is (no node move, no outbox, no send), a reversible
// halt — resuming (status→'active') lets the next tick advance it normally.
// Real Postgres; SQS captured. File-local UUIDs.
const RUN = hasDatabaseUrl();
const WS = 'ca110000-0000-0000-0000-00000000a5e1';
const CAMP = 'ca110000-0000-0000-0000-00000000a5e2';
const PROF = 'ca110000-0000-0000-0000-00000000a5e3';
const TPL = 'ca110000-0000-0000-0000-00000000a5e4';

const DEF: AutomationDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'a' },
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

describe.skipIf(!RUN)('paused automation is not advanced by the runner (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await admin.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<h/>')",
      [TPL, WS],
    );
    await admin.query('INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,$3)', [PROF, WS, 'p@e.test']);
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
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  function deps(sqs: CapturingSqs): RunDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: sqs as never,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => new Date('2026-06-20T12:00:00.000Z'),
      dispatchQueueUrl: 'q',
    };
  }

  it('a paused automation leaves its due enrollment parked; resuming advances it', async () => {
    const enr = await admin.query<{ id: string }>(
      "INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now()) RETURNING id",
      [WS, CAMP, PROF],
    );
    const enrollmentId = enr.rows[0]!.id;

    // PAUSE the automation, then run the tick → the runner SKIPS it.
    await admin.query("UPDATE automations SET status = 'paused' WHERE id = $1", [CAMP]);
    const sqs1 = new CapturingSqs();
    const r1 = await runEnrollment(deps(sqs1), enrollmentId);
    expect(r1.result).toBe('skipped');
    expect(sqs1.bodies).toHaveLength(0);

    // The enrollment is untouched — still active at the trigger node, no outbox row.
    const parked = await admin.query<{ current_node: string; status: string }>(
      'SELECT current_node, status FROM automation_enrollments WHERE id = $1',
      [enrollmentId],
    );
    expect(parked.rows[0]!.current_node).toBe('t');
    expect(parked.rows[0]!.status).toBe('active');
    const ob0 = await admin.query('SELECT 1 FROM outbox WHERE workspace_id = $1', [WS]);
    expect(ob0.rowCount).toBe(0);

    // RESUME → the same enrollment now advances normally (send → exit), proving
    // pause is a reversible halt, not a mutation on the enrollment row.
    await admin.query("UPDATE automations SET status = 'active' WHERE id = $1", [CAMP]);
    const sqs2 = new CapturingSqs();
    const r2 = await runEnrollment(deps(sqs2), enrollmentId);
    expect(r2.result).toBe('completed');
    expect(sqs2.bodies).toHaveLength(1);
    const fin = await admin.query<{ status: string }>('SELECT status FROM automation_enrollments WHERE id = $1', [enrollmentId]);
    expect(fin.rows[0]!.status).toBe('completed');
  });
});
