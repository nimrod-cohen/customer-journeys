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
import type { CampaignDefinition } from '../src/dsl.js';

// PART A: a campaign SEND node referencing a COPY email instance (subject/To/From
// on the copy) flows through outbox -> the REAL Dispatcher -> messages_log(campaign_id)
// with subject/To/body merge tags RENDERED + the From resolved from sender_id (no
// no-reply fallback). SES mocked. Exactly-once on replay.
const RUN = hasDatabaseUrl();
const WS = 'ca115e80-0000-0000-0000-0000000000a1';
const CAMP = 'ca115e80-0000-0000-0000-0000000000c1';
const DOMAIN = 'ca115e80-0000-0000-0000-0000000000d1';
const SENDER = 'ca115e80-0000-0000-0000-0000000000f1';
const COPY = 'ca115e80-0000-0000-0000-0000000000e1';

const DEF: CampaignDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'send' },
    send: { type: 'action', kind: 'send', template_id: COPY, next: 'x' },
    x: { type: 'exit' },
  },
};

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
  async createConfigurationSet() {}
  async provisionDedicatedIp() {}
}

class CapturingSqs {
  public bodies: string[] = [];
  async send(c: { input?: { MessageBody?: string } }) {
    this.bodies.push(c.input?.MessageBody ?? '');
    return {};
  }
}

describe.skipIf(!RUN)('campaign send-node instance through the real dispatcher (real Postgres)', () => {
  let admin: Pool;
  const NOW = new Date('2026-06-07T12:00:00.000Z');

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'W','active',$2::jsonb)",
      [WS, JSON.stringify({ verified: true, from_domain: 'mail.acme.com', config_set: 'cs' })],
    );
    await admin.query(
      "INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'mail.acme.com',true)",
      [DOMAIN, WS],
    );
    await admin.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'mail.acme.com','Acme Team','team@mail.acme.com')",
      [SENDER, WS],
    );
    // The COPY email instance: subject/To merge tags + a verified-domain sender.
    await admin.query(
      `INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html, kind, subject, sender_id, to_address)
       VALUES ($1,$2,'copy','<m/>','<p>Hello {{customer.tier}}</p>','copy','Hi {{customer.email}} ({{customer.tier}})',$3,'{{customer.email}}')`,
      [COPY, WS, SENDER],
    );
    await admin.query(
      "INSERT INTO campaigns (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')",
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
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM domain_senders WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM sending_domains WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
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

  it('renders subject/To/body, resolves From from sender_id, writes messages_log(campaign_id); exactly-once', async () => {
    const p = await admin.query(
      'INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,$3::jsonb) RETURNING id',
      [WS, 'gold@example.com', JSON.stringify({ tier: 'gold' })],
    );
    await admin.query(
      "INSERT INTO campaign_enrollments (workspace_id, campaign_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now())",
      [WS, CAMP, p.rows[0].id],
    );
    const enr = await admin.query('SELECT id FROM campaign_enrollments WHERE workspace_id = $1', [WS]);

    const sqs = new CapturingSqs();
    const r = await runEnrollment(runnerDeps(sqs), enr.rows[0].id);
    expect(r.result).toBe('completed');
    expect(sqs.bodies).toHaveLength(1);

    // ONE outbox row with campaign_id + the node-scoped dedupe_key.
    const ob = await admin.query<{ id: string; campaign_id: string; dedupe_key: string }>(
      'SELECT id, campaign_id, dedupe_key FROM outbox WHERE workspace_id = $1',
      [WS],
    );
    expect(ob.rows).toHaveLength(1);
    expect(ob.rows[0]!.campaign_id).toBe(CAMP);
    expect(ob.rows[0]!.dedupe_key).toBe(`campaign:${CAMP}:${p.rows[0].id}:send`);

    // The REAL dispatcher per enqueued id.
    const ses = new CountingSes();
    const outcome = await dispatchOutbox(dispatchDeps(ses), parseOutboxIdFromSqsRecord(sqs.bodies[0]!));
    expect(outcome.result).toBe('send');
    expect(ses.sends).toHaveLength(1);
    const sent = ses.sends[0]!;
    // From resolved from sender_id — NO no-reply fallback.
    expect(sent.from).toBe('"Acme Team" <team@mail.acme.com>');
    expect(sent.to).toBe('gold@example.com'); // {{customer.email}} rendered
    expect(sent.subject).toBe('Hi gold@example.com (gold)'); // subject merge tags rendered
    expect(sent.html).toContain('Hello gold'); // body merge tag rendered

    // messages_log: campaign_id set, broadcast_id null.
    const ml = await admin.query<{ campaign_id: string | null; broadcast_id: string | null; ses_message_id: string }>(
      'SELECT campaign_id, broadcast_id, ses_message_id FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(ml.rows).toHaveLength(1);
    expect(ml.rows[0]!.campaign_id).toBe(CAMP);
    expect(ml.rows[0]!.broadcast_id).toBeNull();
    expect(ml.rows[0]!.ses_message_id).toBeTruthy();

    // EXACTLY-ONCE: replaying dispatchOutbox claims nothing more (one messages_log row).
    const again = await dispatchOutbox(dispatchDeps(ses), parseOutboxIdFromSqsRecord(sqs.bodies[0]!));
    expect(again.result).not.toBe('send');
    expect(ses.sends).toHaveLength(1);
    const ml2 = await admin.query('SELECT 1 FROM messages_log WHERE workspace_id = $1', [WS]);
    expect(ml2.rows).toHaveLength(1);
  });
});
