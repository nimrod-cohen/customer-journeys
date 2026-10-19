import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

// The runner's email-channel gate must agree with configuration readiness
// (@cdp/shared isEmailChannelReady): a self-hosted `smtp` company with a verified
// domain AND a sender is email-enabled. It used to count only `resend` and `ses`,
// so every automation email send node of an smtp company was silently skipped —
// the enrollment advanced and no outbox row was written. Real Postgres.
const RUN = hasDatabaseUrl();
const CO = 'ca110000-0000-0000-0000-0000000e3c00';
const WS = 'ca110000-0000-0000-0000-0000000e3c01';
const CAMP = 'ca110000-0000-0000-0000-0000000e3c02';
const PROF = 'ca110000-0000-0000-0000-0000000e3c03';
const TPL = 'ca110000-0000-0000-0000-0000000e3c04';

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

describe.skipIf(!RUN)('automation email send gates on email readiness (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO companies (id, name) VALUES ($1,'SMTP Co')", [CO]);
    await admin.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [WS, CO]);
    await admin.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<h/>')",
      [TPL, WS],
    );
    await admin.query('INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,$3)', [PROF, WS, 'p@e.test']);
    await admin.query(
      "INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')",
      [CAMP, WS, JSON.stringify(DEF)],
    );
    await admin.query("INSERT INTO company_connectors (company_id, channel, provider) VALUES ($1,'email','smtp')", [CO]);
    await admin.query("INSERT INTO sending_domains (workspace_id, domain, verified) VALUES ($1,'smtp.test',true)", [WS]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [WS]);
  });

  async function cleanup() {
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM automations WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM domain_senders WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM sending_domains WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await admin.query('DELETE FROM company_connectors WHERE company_id = $1', [CO]);
    await admin.query('DELETE FROM companies WHERE id = $1', [CO]);
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

  async function enrollAndRun(): Promise<number> {
    const enr = await admin.query<{ id: string }>(
      "INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now()) RETURNING id",
      [WS, CAMP, PROF],
    );
    const r = await runEnrollment(deps(new CapturingSqs()), enr.rows[0]!.id);
    expect(r.result).toBe('completed');
    const ob = await admin.query('SELECT 1 FROM outbox WHERE workspace_id = $1', [WS]);
    return ob.rowCount ?? 0;
  }

  it('smtp + verified domain but NO sender: email is not ready, the send is skipped', async () => {
    expect(await enrollAndRun()).toBe(0);
  });

  it('smtp + verified domain + sender: the email send node writes an outbox row', async () => {
    await admin.query(
      "INSERT INTO domain_senders (workspace_id, domain, name, email) VALUES ($1,'smtp.test','Hi','hi@smtp.test')",
      [WS],
    );
    expect(await enrollAndRun()).toBe(1);
  });
});
