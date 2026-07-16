// Campaign channel gating (real Postgres): the runner SKIPS a send node whose
// channel has no connector — the enrollment still advances (the step is ignored as
// if it doesn't exist). A company with ≥1 connector is gated; adding the missing
// connector makes the send fire.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import {
  runEnrollment,
  enrollProfileManually,
  buildSweepQuery,
  runStatementsInWorkspaceTx,
  withWorkspaceTx,
  type RunDeps,
  type Reader,
  type EnrollDeps,
} from '@cdp/service-campaign-runner';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const P = '0c0d0f05-0000-4000-8000-';
const CO = `${P}0000000000f1`;
const WS = `${P}000000000a01`;
const TPL = `${P}0000000000e1`;

describeMaybe('campaign channel gating — runner skips disabled-channel sends (real Postgres)', () => {
  let admin: Pool;
  const runnerDeps = (now: Date): RunDeps => ({
    reader: { query: (t, v) => admin.query(t, v as unknown[]) as never } as Reader,
    sqs: { async send() { return {}; } } as never,
    withTx: (fn) => withWorkspaceTx(admin, fn),
    runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
    now: () => now,
    dispatchQueueUrl: 'q',
  });
  const enrollDeps = (): EnrollDeps => ({
    reader: { query: (t: string, v?: readonly unknown[]) => admin.query(t, v as unknown[]) } as never,
    runInWorkspaceTx: (w: string, s: never) => runStatementsInWorkspaceTx(admin, w, s),
  });

  const emailCampaign = {
    startNode: 't',
    nodes: {
      t: { type: 'trigger', kind: 'manual', next: 's' },
      s: { type: 'action', kind: 'send', template_id: TPL, next: 'x' },
      x: { type: 'exit' },
    },
  };

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO companies (id, name) VALUES ($1,'Acme')", [CO]);
    await admin.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [WS, CO]);
    // Company has an SMS connector → gating is ACTIVE; email has NO connector → disabled.
    await admin.query(
      "INSERT INTO company_connectors (company_id, channel, provider, config, secret, enabled) VALUES ($1,'sms','019','{}'::jsonb,'x',true)",
      [CO],
    );
    await admin.query(
      "INSERT INTO email_templates (id, workspace_id, name, kind, mjml, compiled_html, subject, to_address) VALUES ($1,$2,'C','copy','<mjml></mjml>','<p>Hi</p>','S','{{customer.email}}')",
      [TPL, WS],
    );
  });
  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });
  async function cleanup(): Promise<void> {
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM company_connectors WHERE company_id = $1', [CO]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await admin.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  async function enrollAndRun(email: string): Promise<string> {
    const p = await admin.query<{ id: string }>('INSERT INTO profiles (workspace_id, email) VALUES ($1,$2) RETURNING id', [WS, email]);
    const profileId = p.rows[0]!.id;
    const c = await admin.query<{ id: string }>(
      "INSERT INTO campaigns (workspace_id, name, definition, status) VALUES ($1,'C',$2::jsonb,'active') RETURNING id",
      [WS, JSON.stringify(emailCampaign)],
    );
    const campaignId = c.rows[0]!.id;
    await enrollProfileManually(enrollDeps(), { workspaceId: WS, campaignId: campaignId, profileId });
    const now = new Date();
    const q = buildSweepQuery(now);
    const { rows } = await admin.query<{ id: string }>(q.text, q.values);
    for (const r of rows) await runEnrollment(runnerDeps(now), r.id);
    return campaignId;
  }

  it('email send is SKIPPED (no outbox) when email has no connector; enrollment completes', async () => {
    const campaignId = await enrollAndRun('a@acme.com');
    const ob = await admin.query('SELECT 1 FROM outbox WHERE workspace_id = $1', [WS]);
    expect(ob.rowCount).toBe(0); // the email send was skipped
    const enr = await admin.query<{ status: string; current_node: string }>(
      'SELECT status, current_node FROM campaign_enrollments WHERE workspace_id = $1 AND campaign_id = $2',
      [WS, campaignId],
    );
    expect(enr.rows[0]!.status).toBe('completed'); // advanced past the send to exit
  });

  it('once an email connector is added, the send fires (outbox written)', async () => {
    await admin.query(
      "INSERT INTO company_connectors (company_id, channel, provider, config, secret, enabled) VALUES ($1,'email','resend',$2::jsonb,'k',true)",
      [CO, JSON.stringify({ from: 'Acme <n@acme.com>' })],
    );
    await enrollAndRun('b@acme.com');
    const ob = await admin.query("SELECT 1 FROM outbox WHERE workspace_id = $1 AND payload->>'medium' IS NULL", [WS]);
    expect(ob.rowCount).toBe(1); // email now enabled → outbox row written
  });
});
