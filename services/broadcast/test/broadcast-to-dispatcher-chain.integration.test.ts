import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SesEmailClient, SendEmailInput, SendEmailResult } from '@cdp/email';
import {
  dispatchOutbox,
  parseOutboxIdFromSqsRecord,
  runStatementsInWorkspaceTx as dispatcherTx,
  type DispatchDeps,
} from '@cdp/service-dispatcher';
import { runBroadcast, type BroadcastDeps, type Reader } from '../src/send.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// CRITICAL invariant: ALL sends go through the Dispatcher guards. We run the
// REAL chain: runBroadcast (outbox + enqueue {outbox_id}) → for each enqueued
// id, the REAL dispatchOutbox. One recipient is SUPPRESSED → that send is
// SKIPPED and the counting fake SES is NEVER called for it. We do NOT
// re-implement suppression here. Real Postgres; counting fake SES.
const RUN = hasDatabaseUrl();
const ws = 'b9000000-0000-0000-0000-0000000000a6';

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
  async send(c: SendMessageCommand) {
    this.bodies.push((c as { input: { MessageBody?: string } }).input.MessageBody ?? '');
    return {};
  }
}

describe.skipIf(!RUN)('broadcast → dispatcher chain with guards (real Postgres)', () => {
  let admin: Pool;
  let broadcastId: string;
  let suppressedEmail = 'chain-suppressed@example.com';
  let okEmail = 'chain-ok@example.com';

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'W','active',$2::jsonb)",
      [ws, JSON.stringify({ verified: true, from_domain: 'mail.acme.com', config_set: 'cs' })],
    );
    const t = await admin.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'t','<m/>','<html>Hi</html>') RETURNING id",
      [ws],
    );
    const templateId = t.rows[0].id;
    const s = await admin.query(
      "INSERT INTO segments (workspace_id, name, kind) VALUES ($1,'seg','manual') RETURNING id",
      [ws],
    );
    const segmentId = s.rows[0].id;
    for (const email of [okEmail, suppressedEmail]) {
      const p = await admin.query(
        'INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$3) RETURNING id',
        [ws, email, email],
      );
      await admin.query(
        "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
        [segmentId, p.rows[0].id, ws],
      );
    }
    // suppress one recipient (per-workspace)
    await admin.query(
      "INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,$2,'unsubscribe')",
      [ws, suppressedEmail],
    );
    const b = await admin.query(
      "INSERT INTO broadcasts (workspace_id, name, template_id, audience_kind, audience_ref, status) VALUES ($1,'B',$2,'segment',$3,'draft') RETURNING id",
      [ws, templateId, segmentId],
    );
    broadcastId = b.rows[0].id;
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  it('broadcast enqueues both recipients; the suppressed one is skipped by the Dispatcher (SES called once)', async () => {
    const reader: Reader = { query: (text, values) => admin.query(text, values as unknown[]) as never };
    const sqs = new CapturingSqs();
    const broadcastDeps: BroadcastDeps = {
      reader,
      sqs,
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => new Date('2026-06-07T12:00:00.000Z'),
      dispatchQueueUrl: 'https://sqs/dispatch',
    };
    const res = await runBroadcast(broadcastDeps, broadcastId);
    expect(res.result).toBe('sent');
    expect(res).toMatchObject({ recipientCount: 2 });
    expect(sqs.bodies).toHaveLength(2);

    // Now run the REAL dispatcher for each enqueued {outbox_id}.
    const ses = new CountingSes();
    const dispatchDeps: DispatchDeps = {
      reader,
      ses,
      runInWorkspaceTx: (w, s) => dispatcherTx(admin, w, s),
      now: () => new Date('2026-06-07T12:00:00.000Z'),
      unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
    };
    const outcomes = [];
    for (const body of sqs.bodies) {
      const id = parseOutboxIdFromSqsRecord(body);
      outcomes.push(await dispatchOutbox(dispatchDeps, id));
    }

    const sends = outcomes.filter((o) => o.result === 'send');
    const skips = outcomes.filter((o) => o.result === 'skip');
    expect(sends).toHaveLength(1);
    expect(skips).toHaveLength(1);
    // SES called ONLY for the non-suppressed recipient.
    expect(ses.sends).toHaveLength(1);

    const ml = await admin.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1', [ws]);
    expect(ml.rows[0].n).toBe(1);
  });
});
