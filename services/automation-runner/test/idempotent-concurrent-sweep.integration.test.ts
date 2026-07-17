import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

// CRITICAL invariant: idempotent advance. Concurrent sweeps / retries on the
// SAME due enrollment must advance it AT MOST ONCE (CAS on updated_at). We fire
// runEnrollment N times concurrently (Promise.all) and assert exactly ONE outbox
// row is created and exactly ONE advance won.
const RUN = hasDatabaseUrl();
const WS = 'ca110000-0000-0000-0000-0000000000f4';
const CAMP = 'ca110000-0000-0000-0000-0000000000c4';
const PROF = 'ca110000-0000-0000-0000-0000000000d5';
const TPL = 'ca110000-0000-0000-0000-0000000000e4';

const DEF: AutomationDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'a' },
    a: { type: 'action', kind: 'send', template_id: TPL, next: 'x' },
    x: { type: 'exit' },
  },
};

describe.skipIf(!RUN)('idempotent concurrent sweep (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await admin.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<h/>')",
      [TPL, WS],
    );
    await admin.query('INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,$3,$3::text)', [
      PROF,
      WS,
      'ext',
    ]);
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

  function deps(): RunDeps {
    // Use a SHARED pool so concurrent ticks genuinely contend on the same rows.
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: { async send() { return {}; } } as never,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => new Date('2026-06-07T12:00:00.000Z'),
      dispatchQueueUrl: 'q',
    };
  }

  it('10 concurrent runs of the same enrollment advance it exactly once', async () => {
    const enr = await admin.query(
      "INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now()) RETURNING id",
      [WS, CAMP, PROF],
    );
    const id = enr.rows[0].id;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => runEnrollment(deps(), id)),
    );
    const completed = results.filter((r) => r.result === 'completed');
    const skipped = results.filter((r) => r.result === 'skipped');

    // Exactly ONE tick won the claim and completed; the rest lost the CAS.
    expect(completed).toHaveLength(1);
    expect(skipped.length).toBe(9);

    // Exactly ONE outbox row (dedupe_key + ON CONFLICT also guards this).
    const ob = await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id = $1', [WS]);
    expect(ob.rows[0].n).toBe(1);

    const fin = await admin.query('SELECT status FROM automation_enrollments WHERE id = $1', [id]);
    expect(fin.rows[0].status).toBe('completed');
  });
});
