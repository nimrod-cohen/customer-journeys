// MULTI-CHANNEL campaign SEND node (v0.54.0) — real Postgres; SES mocked; the
// channel provider is the deterministic @cdp/channels MOCK (resolveChannel default).
// A campaign whose send node is medium='sms' (or whatsapp) enrolls → runner advances
// → an outbox row tagged payload.medium=sms + payload.text_body → the REAL Dispatcher
// renders the body merge tags + {{customer.phone}} To and sends via the mock provider
// → messages_log(campaign_id, medium='sms') with a mock provider id. Asserts:
//   - the outbox payload carries medium + text_body for a text send;
//   - topic-gating skips a topic-unsubscribed profile (campaigns.topic_id);
//   - idempotent re-tick (no second outbox/send);
//   - an EMAIL campaign send still works (regression — outbox.template_id, SES);
//   - everything workspace-scoped (a parallel WS_B campaign untouched).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SesEmailClient, SendEmailInput, SendEmailResult } from '@cdp/email';
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
import {
  dispatchOutbox,
  runStatementsInWorkspaceTx as dispatcherTx,
  type DispatchDeps,
} from '@cdp/service-dispatcher';

const RUN = hasDatabaseUrl();
const describeMaybe = RUN ? describe : describe.skip;

// Unused prefix (grep'd 0c0d0e**): 0c0d0ed0.
const WS = '0c0d0ed0-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ed0-0000-4000-8000-000000000a02';
const DOMAIN = '0c0d0ed0-0000-4000-8000-0000000000d1';
const SENDER = '0c0d0ed0-0000-4000-8000-0000000000f1';
const TOPIC = '0c0d0ed0-0000-4000-8000-0000000000c1';

// An SMS journey: trigger(manual) → send(sms, body) → exit.
const smsDef = () => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 's' },
    s: { type: 'action', kind: 'send', medium: 'sms', text_body: 'Hi {{customer.first_name}}!', next: 'x' },
    x: { type: 'exit' },
  },
});

// An email journey: trigger(manual) → send(email copy) → exit.
const emailDef = (copyId: string) => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 's' },
    s: { type: 'action', kind: 'send', template_id: copyId, next: 'x' },
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

describeMaybe('multi-channel campaign send node (real Postgres)', () => {
  let admin: Pool;

  function runnerDeps(now: Date, sqs: CapturingSqs): RunDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: sqs as never,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => now,
      dispatchQueueUrl: 'q',
    };
  }
  function dispatchDeps(ses: SesEmailClient, now: Date): DispatchDeps {
    const reader = { query: (t: string, v?: readonly unknown[]) => admin.query(t, v as unknown[]) };
    return {
      reader: reader as never,
      ses,
      // resolveChannel defaults to the @cdp/channels mock — no need to inject.
      runInWorkspaceTx: (w, s) => dispatcherTx(admin, w, s),
      now: () => now,
      unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
      linkTrackingBaseUrl: 'https://api.cdp.example',
    };
  }
  const enrollDeps = (): EnrollDeps => ({
    reader: { query: (t: string, v?: readonly unknown[]) => admin.query(t, v as unknown[]) } as never,
    runInWorkspaceTx: (w: string, s: never) => runStatementsInWorkspaceTx(admin, w, s),
  });

  // Sweep + advance every due enrollment until none are due (single-tick journeys
  // here, but loop for safety). Returns the enqueued outbox ids drained.
  async function sweepAndAdvance(now: Date): Promise<void> {
    const q = buildSweepQuery(now);
    const { rows } = await admin.query<{ id: string }>(q.text, q.values);
    const sqs = new CapturingSqs();
    for (const r of rows) {
      await runEnrollment(runnerDeps(now, sqs), r.id);
    }
  }

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const w of [WS, WS_B]) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    }
    await admin.query("INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'mail.acme.com',true)", [DOMAIN, WS]);
    await admin.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'mail.acme.com','Acme','team@mail.acme.com')",
      [SENDER, WS],
    );
    await admin.query("INSERT INTO topics (id, workspace_id, name) VALUES ($1,$2,'News')", [TOPIC, WS]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM topic_subscriptions WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM topics WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM domain_senders WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM sending_domains WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  async function makeProfile(ws: string, email: string, phone: string | null, firstName: string): Promise<string> {
    const attrs: Record<string, unknown> = { first_name: firstName };
    if (phone) attrs.phone = phone;
    const p = await admin.query<{ id: string }>(
      'INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,$3::jsonb) RETURNING id',
      [ws, email, JSON.stringify(attrs)],
    );
    return p.rows[0]!.id;
  }

  async function makeCampaign(ws: string, definition: object, topicId: string | null): Promise<string> {
    const c = await admin.query<{ id: string }>(
      "INSERT INTO campaigns (workspace_id, name, definition, status, topic_id) VALUES ($1,'C',$2::jsonb,'active',$3) RETURNING id",
      [ws, JSON.stringify(definition), topicId],
    );
    return c.rows[0]!.id;
  }

  it('SMS send node → outbox(medium=sms,text) → REAL dispatcher(mock) → messages_log(medium=sms) with merged body', async () => {
    const camp = await makeCampaign(WS, smsDef(), null);
    const profileId = await makeProfile(WS, 'sms@example.com', '+972529461566', 'Sam');
    await enrollProfileManually(enrollDeps(), { workspaceId: WS, campaignId: camp, profileId });

    const now = new Date();
    await sweepAndAdvance(now); // advances trigger → send → exit, inserting the outbox row

    // The outbox row carries the medium + text body in its PAYLOAD (no template_id).
    const ob = await admin.query<{ template_id: string | null; payload: Record<string, unknown>; status: string }>(
      'SELECT template_id, payload, status FROM outbox WHERE workspace_id = $1 AND campaign_id = $2',
      [WS, camp],
    );
    expect(ob.rowCount).toBe(1);
    expect(ob.rows[0]!.template_id).toBeNull();
    expect(ob.rows[0]!.payload.medium).toBe('sms');
    expect(ob.rows[0]!.payload.text_body).toBe('Hi {{customer.first_name}}!');

    // Dispatch the campaign outbox through the REAL dispatcher (mock channel provider).
    const ses = new CountingSes();
    const out = await dispatchOutbox(dispatchDeps(ses, now), await pendingId(camp));
    expect(out.result).toBe('send');
    expect(ses.sends).toHaveLength(0); // a text send never calls SES

    const ml = await admin.query<{ medium: string; status: string; ses_message_id: string | null }>(
      'SELECT medium, status, ses_message_id FROM messages_log WHERE workspace_id = $1 AND campaign_id = $2',
      [WS, camp],
    );
    expect(ml.rowCount).toBe(1);
    expect(ml.rows[0]!.medium).toBe('sms');
    expect(ml.rows[0]!.status).toBe('sent');
    expect(ml.rows[0]!.ses_message_id).toMatch(/^mock-sms-/);

    // The enrollment completed.
    const enr = await admin.query<{ status: string }>(
      'SELECT status FROM campaign_enrollments WHERE workspace_id = $1 AND campaign_id = $2 AND profile_id = $3',
      [WS, camp, profileId],
    );
    expect(enr.rows[0]!.status).toBe('completed');
  });

  // Resolve the single pending campaign outbox id (helper for the dispatch step).
  async function pendingId(camp: string): Promise<string> {
    const r = await admin.query<{ id: string }>(
      "SELECT id FROM outbox WHERE workspace_id = $1 AND campaign_id = $2 AND status = 'pending'",
      [WS, camp],
    );
    return r.rows[0]!.id;
  }

  it('idempotent re-tick: a second sweep + dispatch adds no second outbox/send', async () => {
    const camp = await makeCampaign(WS, smsDef(), null);
    const profileId = await makeProfile(WS, 'idem@example.com', '+972521112222', 'Ida');
    await enrollProfileManually(enrollDeps(), { workspaceId: WS, campaignId: camp, profileId });
    const now = new Date();
    await sweepAndAdvance(now);
    const id = await pendingId(camp);
    const ses = new CountingSes();
    await dispatchOutbox(dispatchDeps(ses, now), id);
    // Re-tick the (now completed) enrollment + re-dispatch the (now sent) row.
    await sweepAndAdvance(new Date(now.getTime() + 1000));
    await dispatchOutbox(dispatchDeps(ses, now), id);

    const ob = await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id = $1 AND campaign_id = $2', [WS, camp]);
    expect((ob.rows[0] as { n: number }).n).toBe(1);
    const ml = await admin.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1 AND campaign_id = $2', [WS, camp]);
    expect((ml.rows[0] as { n: number }).n).toBe(1);
  });

  it('topic-gating: a topic-unsubscribed profile is SKIPPED (no provider send)', async () => {
    const camp = await makeCampaign(WS, smsDef(), TOPIC);
    const profileId = await makeProfile(WS, 'topicoff@example.com', '+972522223333', 'Tom');
    // Explicit opt-out of the topic (default-on otherwise).
    await admin.query(
      "INSERT INTO topic_subscriptions (workspace_id, profile_id, topic_id, subscribed) VALUES ($1,$2,$3,false)",
      [WS, profileId, TOPIC],
    );
    await enrollProfileManually(enrollDeps(), { workspaceId: WS, campaignId: camp, profileId });
    const now = new Date();
    await sweepAndAdvance(now);
    const id = await pendingId(camp);
    const ses = new CountingSes();
    const out = await dispatchOutbox(dispatchDeps(ses, now), id);
    expect(out.result).toBe('skip');

    // messages_log records the skip (auditable), but it is NOT a sent provider row.
    const ml = await admin.query<{ status: string; ses_message_id: string | null }>(
      'SELECT status, ses_message_id FROM messages_log WHERE workspace_id = $1 AND campaign_id = $2',
      [WS, camp],
    );
    expect(ml.rowCount).toBe(1);
    expect(ml.rows[0]!.status).toBe('skipped');
    expect(ml.rows[0]!.ses_message_id).toBeNull();
  });

  it('EMAIL campaign send still works (regression): outbox.template_id → SES', async () => {
    const copy = await admin.query<{ id: string }>(
      `INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, kind, subject, sender_id, to_address)
       VALUES ($1,'copy','<m/>','<p>Hello {{customer.first_name}}</p>','copy','Hi {{customer.first_name}}',$2,'{{customer.email}}') RETURNING id`,
      [WS, SENDER],
    );
    const camp = await makeCampaign(WS, emailDef(copy.rows[0]!.id), null);
    const profileId = await makeProfile(WS, 'email@example.com', null, 'Ed');
    await enrollProfileManually(enrollDeps(), { workspaceId: WS, campaignId: camp, profileId });
    const now = new Date();
    await sweepAndAdvance(now);

    const ob = await admin.query<{ template_id: string | null; payload: Record<string, unknown> }>(
      'SELECT template_id, payload FROM outbox WHERE workspace_id = $1 AND campaign_id = $2',
      [WS, camp],
    );
    expect(ob.rows[0]!.template_id).toBe(copy.rows[0]!.id);
    expect(ob.rows[0]!.payload.medium).toBeUndefined(); // email → no medium tag

    const id = await pendingId(camp);
    const ses = new CountingSes();
    const out = await dispatchOutbox(dispatchDeps(ses, now), id);
    expect(out.result).toBe('send');
    expect(ses.sends).toHaveLength(1);
    expect(ses.sends[0]!.subject).toBe('Hi Ed'); // merge rendered
    const ml = await admin.query<{ medium: string }>(
      "SELECT medium FROM messages_log WHERE workspace_id = $1 AND campaign_id = $2 AND status = 'sent'",
      [WS, camp],
    );
    expect(ml.rows[0]!.medium).toBe('email');
  });

  it('workspace-scoped: a WS_B campaign+enrollment is untouched by WS dispatch', async () => {
    const campB = await makeCampaign(WS_B, smsDef(), null);
    const pB = await makeProfile(WS_B, 'b@example.com', '+972529998888', 'Bea');
    await enrollProfileManually(enrollDeps(), { workspaceId: WS_B, campaignId: campB, profileId: pB });
    // Advancing WS_B's enrollment writes only WS_B rows.
    const now = new Date();
    await sweepAndAdvance(now);
    const obB = await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id = $1', [WS_B]);
    expect((obB.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
    // The WS_B outbox row's workspace_id is WS_B, never WS.
    const cross = await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id = $1 AND campaign_id = $2', [WS, campB]);
    expect((cross.rows[0] as { n: number }).n).toBe(0);
  });
});
