import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SesEmailClient, SendEmailInput, SendEmailResult } from '@cdp/email';
import {
  dispatchOutbox,
  parseOutboxIdFromSqsRecord,
  runStatementsInWorkspaceTx as dispatcherTx,
  type DispatchDeps,
} from '@cdp/service-dispatcher';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

// CRITICAL invariant: ALL automation sends go through the REAL dispatchOutbox
// (gate→suppression→cap→quiet-hours). We run the runner (which enqueues
// {outbox_id}) then the REAL dispatcher per id. A suppressed recipient is
// SKIPPED; the runner NEVER calls SES. A separate sub-test proves an unverified
// workspace is REFUSED.
const RUN = hasDatabaseUrl();
const WS = 'ca110000-0000-0000-0000-0000000000f6';
const WS_UNVERIFIED = 'ca110000-0000-0000-0000-0000000000f7';
const CAMP = 'ca110000-0000-0000-0000-0000000000c6';
const CAMP_U = 'ca110000-0000-0000-0000-0000000000c7';
const TPL = 'ca110000-0000-0000-0000-0000000000e6';
const TPL_U = 'ca110000-0000-0000-0000-0000000000e7';

const DEF = (tpl: string): AutomationDefinition => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'a' },
    a: { type: 'action', kind: 'send', template_id: tpl, next: 'x' },
    x: { type: 'exit' },
  },
});

class CountingSes implements SesEmailClient {
  public sends: SendEmailInput[] = [];
  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    this.sends.push(input);
    return { sesMessageId: `ses-${this.sends.length}` };
  }
  async createDomainIdentity() {
    return { identity: '', dkimTokens: [] };
  }
  async getIdentityVerificationAttributes() {
    return { dkimStatus: 'SUCCESS' as const, signingEnabled: true, dkimTokens: [] };
  }
  async createConfigurationSet() {
    /* no-op */
  }
  async provisionDedicatedIp() {
    /* no-op */
  }
}

class CapturingSqs {
  public bodies: string[] = [];
  async send(c: { input?: { MessageBody?: string } }) {
    this.bodies.push(c.input?.MessageBody ?? '');
    return {};
  }
}

describe.skipIf(!RUN)('automation sends flow through the real dispatcher (real Postgres)', () => {
  let admin: Pool;
  const okEmail = 'camp-ok@example.com';
  const suppressedEmail = 'camp-supp@example.com';

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    // verified/active workspace
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'W','active',$2::jsonb)",
      [WS, JSON.stringify({ verified: true, from_domain: 'mail.acme.com', config_set: 'cs' })],
    );
    await admin.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<h/>')",
      [TPL, WS],
    );
    await admin.query(
      "INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')",
      [CAMP, WS, JSON.stringify(DEF(TPL))],
    );
    await admin.query(
      "INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,$2,'unsubscribe')",
      [WS, suppressedEmail],
    );

    // unverified/onboarding workspace (Dispatcher must REFUSE)
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'U','onboarding',$2::jsonb)",
      [WS_UNVERIFIED, JSON.stringify({ verified: false })],
    );
    await admin.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<h/>')",
      [TPL_U, WS_UNVERIFIED],
    );
    await admin.query(
      "INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')",
      [CAMP_U, WS_UNVERIFIED, JSON.stringify(DEF(TPL_U))],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    for (const w of [WS, WS_UNVERIFIED]) {
      await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM automations WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  const NOW = new Date('2026-06-07T12:00:00.000Z');

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

  function dispatchDeps(ses: SesEmailClient): DispatchDeps {
    const reader = { query: (t: string, v?: readonly unknown[]) => admin.query(t, v as unknown[]) };
    return {
      reader: reader as never,
      ses,
      runInWorkspaceTx: (w, s) => dispatcherTx(admin, w, s),
      now: () => NOW,
      unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
    };
  }

  it('suppressed recipient is SKIPPED by the dispatcher; runner never calls SES', async () => {
    const ok = await admin.query(
      'INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$3) RETURNING id',
      [WS, 'ok', okEmail],
    );
    const supp = await admin.query(
      'INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$3) RETURNING id',
      [WS, 'supp', suppressedEmail],
    );
    for (const pid of [ok.rows[0].id, supp.rows[0].id]) {
      await admin.query(
        "INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now())",
        [WS, CAMP, pid],
      );
    }
    const enrs = await admin.query(
      'SELECT id FROM automation_enrollments WHERE workspace_id = $1',
      [WS],
    );

    const sqs = new CapturingSqs();
    for (const e of enrs.rows) {
      const r = await runEnrollment(runnerDeps(sqs), e.id);
      expect(r.result).toBe('completed');
    }
    expect(sqs.bodies).toHaveLength(2);

    // Run the REAL dispatcher per enqueued id.
    const ses = new CountingSes();
    const outcomes = [];
    for (const body of sqs.bodies) {
      outcomes.push(await dispatchOutbox(dispatchDeps(ses), parseOutboxIdFromSqsRecord(body)));
    }
    expect(outcomes.filter((o) => o.result === 'send')).toHaveLength(1);
    expect(outcomes.filter((o) => o.result === 'skip')).toHaveLength(1);
    expect(ses.sends).toHaveLength(1); // only the non-suppressed recipient
  });

  it('unverified workspace is REFUSED by the dispatcher (never sent)', async () => {
    const p = await admin.query(
      'INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$3) RETURNING id',
      [WS_UNVERIFIED, 'u', 'u@example.com'],
    );
    await admin.query(
      "INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now())",
      [WS_UNVERIFIED, CAMP_U, p.rows[0].id],
    );
    const e = await admin.query(
      'SELECT id FROM automation_enrollments WHERE workspace_id = $1',
      [WS_UNVERIFIED],
    );
    const sqs = new CapturingSqs();
    await runEnrollment(runnerDeps(sqs), e.rows[0].id);
    expect(sqs.bodies).toHaveLength(1);

    const ses = new CountingSes();
    const outcome = await dispatchOutbox(dispatchDeps(ses), parseOutboxIdFromSqsRecord(sqs.bodies[0]!));
    expect(outcome.result).toBe('refuse');
    expect(ses.sends).toHaveLength(0);
  });
});
