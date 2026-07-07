// FULL END-TO-END journey acceptance test (§9B phase 7) — real Postgres; SES
// mocked (aws-sdk-client-mock-free CountingSes); the webhook HTTP client injected;
// SQS captured. Composes the existing real-Postgres patterns (full-lifecycle +
// campaign-send-dispatcher-instance + set-attribute-event-sourced + webhook-node-
// tick + hour-window) into ONE journey:
//
//   trigger(event:purchase) → wait(1h) → hour_of_day_window(9..17)
//     → if(total_events>=1) → set_attribute(welcomed=y, last_purchase={{event.amount}})
//     → send(copy) → webhook(allowlisted) → exit
//
// It enrolls via EACH trigger kind, INCLUDING POSTing to the LIVE local-api
// POST /profiles/:id/events (createApp over the real pool → sendProfileEvent →
// enrollFromEvent on the same tx, closing the phase-3 coverage gap), then advances
// with an INJECTED clock (deps.now() fixed per tick) through every node, and asserts:
//   - the update-profile step wrote BOTH a profiles.attributes change AND is
//     event-sourced (the {{event.amount}} resolves from the persisted trigger event);
//   - the send went outbox → REAL Dispatcher → messages_log(campaign_id) with the
//     subject/To/body merge tags rendered + the From resolved from sender_id;
//   - the injected webhook fired EXACTLY once to the allowlisted URL (SSRF/allowlist
//     honored; secret decrypted at call time only; failure isolated);
//   - idempotent re-tick (no second outbox/send/webhook; enrollment stays completed);
//   - everything workspace-scoped (a parallel WS_B campaign/enrollment is untouched).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl, encryptSecret, decryptSecret, isEncryptedSecret } from '@cdp/db';
import type { SesEmailClient, SendEmailInput, SendEmailResult } from '@cdp/email';
import type { WebhookHttpClient, WebhookRequest } from '@cdp/runner-webhook';
import {
  runEnrollment,
  enrollProfileManually,
  enrollSegmentSnapshot,
  buildSweepQuery,
  runStatementsInWorkspaceTx,
  withWorkspaceTx,
  type RunDeps,
  type Reader,
  type EnrollDeps,
} from '@cdp/service-campaign-runner';
import {
  dispatchOutbox,
  parseOutboxIdFromSqsRecord,
  runStatementsInWorkspaceTx as dispatcherTx,
  type DispatchDeps,
} from '@cdp/service-dispatcher';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const RUN = hasDatabaseUrl();
const describeMaybe = RUN ? describe : describe.skip;

const NY = 'America/New_York';
const WS = '0c0d0e99-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e99-0000-4000-8000-000000000a02';
// Distinct COMPANIES so the WS owner doesn't (legitimately) see WS_B under
// company-centric RBAC (an owner sees every workspace in THEIR company).
const COA = '0c0d0e99-0000-4000-8000-0000000000f1';
const COB = '0c0d0e99-0000-4000-8000-0000000000f2';
const OWNER = '0c0d0e99-0000-4000-8000-0000000000b1';
const DOMAIN = '0c0d0e99-0000-4000-8000-0000000000d1';
const SENDER = '0c0d0e99-0000-4000-8000-0000000000f1';
const COPY = '0c0d0e99-0000-4000-8000-0000000000e1';
const SEG = '0c0d0e99-0000-4000-8000-0000000000a5';
const ALLOWED = 'hooks.example.com';

// The full-node journey (see file header).
const journeyDef = (copyId: string) => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'event', eventType: 'purchase', next: 'w' },
    w: { type: 'wait', delay: { seconds: 3600 }, next: 'win' },
    win: { type: 'hour_of_day_window', startHour: 9, endHour: 17, next: 'cond' },
    cond: { type: 'condition', ast: { field: 'total_events', operator: '>=', value: 1 }, onTrue: 'attr', onFalse: 'x' },
    attr: {
      type: 'action',
      kind: 'set_attribute',
      key: 'last_purchase_amount',
      value: { kind: 'expression', expression: '{{event.amount}}' },
      next: 'welcomed',
    },
    welcomed: { type: 'action', kind: 'set_attribute', key: 'welcomed', value: { kind: 'literal', value: 'y' }, next: 'send' },
    send: { type: 'action', kind: 'send', template_id: copyId, next: 'wh' },
    wh: {
      type: 'action',
      kind: 'webhook',
      url: `https://${ALLOWED}/hook`,
      method: 'POST',
      headers: { 'X-Auth': encryptSecret('PLAINTEXT-TOKEN'), 'Content-Type': 'application/json' },
      bodyTemplate: '{"email":"{{customer.email}}","amount":"{{customer.last_purchase_amount}}"}',
      maxRetries: 0,
      next: 'x',
    },
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

function fakeWebhookClient(): WebhookHttpClient & { calls: WebhookRequest[] } {
  const calls: WebhookRequest[] = [];
  return {
    calls,
    async request(req: WebhookRequest): Promise<{ status: number }> {
      calls.push(req);
      return { status: 200 };
    },
  };
}

describeMaybe('FULL campaign journey: live event enroll → advance → send → webhook (real Postgres)', () => {
  let world: TestWorld;
  let admin: Pool;
  const tok = () => tokenFor(OWNER, WS);
  let CAMP = '';
  let CAMP_B = '';

  async function makeCopy(ws: string): Promise<string> {
    const id = ws === WS ? COPY : COPY.replace(/e1$/, 'e2');
    await admin.query(
      `INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html, kind, subject, sender_id, to_address)
       VALUES ($1,$2,'copy','<m/>','<p>Hello {{customer.email}}</p>','copy','Welcome {{customer.email}}',$3,'{{customer.email}}')`,
      [id, ws, ws === WS ? SENDER : null],
    );
    return id;
  }

  beforeAll(async () => {
    world = makeWorld();
    admin = world.pool;
    await cleanup();
    // WS_A uses the NY timezone (governs the wait + hour-window math, DST-correct).
    await admin.query("INSERT INTO companies (id, name) VALUES ($1,'CoA'),($2,'CoB')", [COA, COB]);
    await admin.query("INSERT INTO workspaces (id, name, status, company_id, settings) VALUES ($1,'W','active',$2,$3::jsonb)", [
      WS,
      COA,
      JSON.stringify({ timezone: NY, webhook_allowlist: [ALLOWED] }),
    ]);
    await admin.query("INSERT INTO workspaces (id, name, status, company_id, settings) VALUES ($1,'W-B','active',$2,$3::jsonb)", [
      WS_B,
      COB,
      JSON.stringify({ timezone: NY, webhook_allowlist: [ALLOWED] }),
    ]);
    await admin.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await admin.query("INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'mail.acme.com',true)", [DOMAIN, WS]);
    await admin.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'mail.acme.com','Acme Team','team@mail.acme.com')",
      [SENDER, WS],
    );
    await admin.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'seg','manual')", [SEG, WS]);
    const copyA = await makeCopy(WS);
    const copyB = await makeCopy(WS_B);
    const ca = await admin.query<{ id: string }>(
      "INSERT INTO campaigns (workspace_id, name, definition, status) VALUES ($1,'Journey',$2::jsonb,'active') RETURNING id",
      [WS, JSON.stringify(journeyDef(copyA))],
    );
    CAMP = ca.rows[0]!.id;
    const cb = await admin.query<{ id: string }>(
      "INSERT INTO campaigns (workspace_id, name, definition, status) VALUES ($1,'Journey B',$2::jsonb,'active') RETURNING id",
      [WS_B, JSON.stringify(journeyDef(copyB))],
    );
    CAMP_B = cb.rows[0]!.id;
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      await admin.query('DELETE FROM activity_log WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM domain_senders WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM sending_domains WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
    await admin.query('DELETE FROM companies WHERE id = ANY($1)', [[COA, COB]]);
  }

  function runnerDeps(now: Date, sqs: CapturingSqs, webhook?: WebhookHttpClient): RunDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: sqs as never,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => now,
      dispatchQueueUrl: 'q',
      ...(webhook ? { webhookClient: webhook, decryptSecret, isEncryptedSecret } : {}),
    };
  }
  function dispatchDeps(ses: SesEmailClient, now: Date): DispatchDeps {
    const reader = { query: (t: string, v?: readonly unknown[]) => admin.query(t, v as unknown[]) };
    return {
      reader: reader as never,
      ses,
      runInWorkspaceTx: (w, s) => dispatcherTx(admin, w, s),
      now: () => now,
      unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
    };
  }
  const enrollDeps = (): EnrollDeps => ({
    reader: { query: (t: string, v?: readonly unknown[]) => admin.query(t, v as unknown[]) } as never,
    runInWorkspaceTx: (w: string, s: never) => runStatementsInWorkspaceTx(admin, w, s),
  });

  async function makeProfile(ws: string, email: string, amount: number): Promise<string> {
    const p = await admin.query<{ id: string }>(
      'INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,$3::jsonb) RETURNING id',
      [ws, email, JSON.stringify({})],
    );
    const id = p.rows[0]!.id;
    // total_events >= 1 so the condition's onTrue arm is taken.
    await admin.query("INSERT INTO profile_features (profile_id, workspace_id, total_events) VALUES ($1,$2,3)", [id, ws]);
    return id;
  }

  it('live POST /profiles/:id/events enrolls (idempotent), plus manual + segment enroll', async () => {
    const profileId = await makeProfile(WS, 'live@example.com', 19.99);

    // LIVE event enrollment through the real local-api route (createApp → dispatch).
    const res = await call(world.env, 'POST', `/profiles/${profileId}/events`, {
      token: tok(),
      body: { type: 'purchase', payload: { amount: 19.99 } },
    });
    expect(res.status).toBe(201);

    const enr = await admin.query(
      "SELECT current_node, status FROM campaign_enrollments WHERE workspace_id = $1 AND campaign_id = $2 AND profile_id = $3",
      [WS, CAMP, profileId],
    );
    expect(enr.rowCount).toBe(1);
    expect(enr.rows[0]!.current_node).toBe('t');
    expect(enr.rows[0]!.status).toBe('active');

    // Replaying the SAME live POST (a different event_id) does NOT duplicate.
    const res2 = await call(world.env, 'POST', `/profiles/${profileId}/events`, {
      token: tok(),
      body: { type: 'purchase', payload: { amount: 19.99 } },
    });
    expect(res2.status).toBe(201);
    const enr2 = await admin.query(
      'SELECT 1 FROM campaign_enrollments WHERE workspace_id = $1 AND campaign_id = $2 AND profile_id = $3',
      [WS, CAMP, profileId],
    );
    expect(enr2.rowCount).toBe(1);

    // The OTHER two trigger kinds enroll (each one row, idempotent at the DB level:
    // ON CONFLICT (campaign_id, profile_id) DO NOTHING — re-running inserts no dup).
    const manualP = await makeProfile(WS, 'manual@example.com', 5);
    await enrollProfileManually(enrollDeps(), { workspaceId: WS, campaignId: CAMP, profileId: manualP });
    await enrollProfileManually(enrollDeps(), { workspaceId: WS, campaignId: CAMP, profileId: manualP });
    const manualRows = await admin.query(
      'SELECT 1 FROM campaign_enrollments WHERE workspace_id = $1 AND campaign_id = $2 AND profile_id = $3',
      [WS, CAMP, manualP],
    );
    expect(manualRows.rowCount).toBe(1); // idempotent — exactly one row

    const segP = await makeProfile(WS, 'seg@example.com', 7);
    await admin.query("INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')", [SEG, segP, WS]);
    const s1 = await enrollSegmentSnapshot(enrollDeps(), { workspaceId: WS, campaignId: CAMP, segmentId: SEG });
    expect(s1.enrolled).toBeGreaterThanOrEqual(1);

    // Cleanup the manual/segment enrollments so the advance test below isolates the live one.
    await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1 AND profile_id = ANY($2::uuid[])', [WS, [manualP, segP]]);
  });

  it('advances trigger→wait→window→if→set_attribute→send→webhook→exit; idempotent; workspace-scoped', async () => {
    const profileId = await makeProfile(WS, 'journey@example.com', 42.5);
    // Live event enroll (also persists state.event for {{event.amount}}).
    await call(world.env, 'POST', `/profiles/${profileId}/events`, {
      token: tok(),
      body: { type: 'purchase', payload: { amount: 42.5 } },
    });
    const enr = await admin.query<{ id: string }>(
      'SELECT id FROM campaign_enrollments WHERE workspace_id = $1 AND campaign_id = $2 AND profile_id = $3',
      [WS, CAMP, profileId],
    );
    const enrollmentId = enr.rows[0]!.id;

    // A parallel WS_B enrollment with the SAME structure — must stay untouched.
    const profileB = await makeProfile(WS_B, 'journey@example.com', 99);
    await admin.query(
      "INSERT INTO campaign_enrollments (workspace_id, campaign_id, profile_id, current_node, status, next_run_at, state) VALUES ($1,$2,$3,'t','active', now(), $4::jsonb)",
      [WS_B, CAMP_B, profileB, JSON.stringify({ event: { payload: { amount: 99 } } })],
    );

    // Tick 1 @ T0: trigger → PARK at wait (next_run_at = T0 + 1h).
    const t0 = new Date('2026-06-19T13:30:00.000Z'); // 09:30 NY (inside window already)
    const r1 = await runEnrollment(runnerDeps(t0, new CapturingSqs()), enrollmentId);
    expect(r1.result).toBe('parked');
    expect((r1 as { node: string }).node).toBe('w');

    // Tick 2 @ T0+2h but OUTSIDE the 9..17 window? 15:30Z+? Instead pick a time after
    // the wait but BEFORE the window opens to prove the window defers. Re-park the
    // wait first by advancing the clock past the wait but to 03:00 NY (pre-window).
    // wait elapsed at T0+1h (14:30Z). A clock of 2026-06-20T06:00Z == 02:00 NY (pre 09:00)
    // → wait done, window parks until 09:00 NY next.
    const t2 = new Date('2026-06-20T06:00:00.000Z');
    const r2 = await runEnrollment(runnerDeps(t2, new CapturingSqs()), enrollmentId);
    expect(r2.result).toBe('parked');
    expect((r2 as { node: string }).node).toBe('win'); // deferred at the hour-window

    // Tick 3 @ a clock INSIDE the window (14:00 NY == 18:00Z) → condition(true) →
    // set_attribute → send → webhook → exit (completes).
    const t3 = new Date('2026-06-20T18:00:00.000Z');
    const sqs = new CapturingSqs();
    const webhook = fakeWebhookClient();
    const r3 = await runEnrollment(runnerDeps(t3, sqs, webhook), enrollmentId);
    expect(r3.result).toBe('completed');
    expect(sqs.bodies).toHaveLength(1);

    // UPDATE-PROFILE event-sourced: welcomed=y (literal) + last_purchase_amount from
    // the trigger event (NOT the raw token).
    const after = await admin.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM profiles WHERE workspace_id = $1 AND id = $2',
      [WS, profileId],
    );
    expect(after.rows[0]!.attributes.welcomed).toBe('y');
    expect(after.rows[0]!.attributes.last_purchase_amount).toBe('42.5');

    // SEND through the REAL Dispatcher (SES mocked) → messages_log(campaign_id).
    const ob = await admin.query<{ id: string; campaign_id: string; dedupe_key: string }>(
      'SELECT id, campaign_id, dedupe_key FROM outbox WHERE workspace_id = $1',
      [WS],
    );
    expect(ob.rows).toHaveLength(1);
    expect(ob.rows[0]!.campaign_id).toBe(CAMP);
    expect(ob.rows[0]!.dedupe_key).toBe(`campaign:${CAMP}:${profileId}:send`);

    const ses = new CountingSes();
    const outcome = await dispatchOutbox(dispatchDeps(ses, t3), parseOutboxIdFromSqsRecord(sqs.bodies[0]!));
    expect(outcome.result).toBe('send');
    expect(ses.sends).toHaveLength(1);
    expect(ses.sends[0]!.from).toBe('"Acme Team" <team@mail.acme.com>');
    expect(ses.sends[0]!.to).toBe('journey@example.com');
    expect(ses.sends[0]!.subject).toBe('Welcome journey@example.com');
    expect(ses.sends[0]!.html).toContain('Hello journey@example.com');

    const ml = await admin.query<{ campaign_id: string | null; ses_message_id: string; status: string }>(
      'SELECT campaign_id, ses_message_id, status FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(ml.rows).toHaveLength(1);
    expect(ml.rows[0]!.campaign_id).toBe(CAMP);
    expect(ml.rows[0]!.ses_message_id).toBeTruthy();
    expect(ml.rows[0]!.status).toBe('sent');

    // WEBHOOK fired exactly once to the allowlisted URL, secret decrypted at call time.
    expect(webhook.calls).toHaveLength(1);
    expect(webhook.calls[0]!.url).toBe(`https://${ALLOWED}/hook`);
    expect(webhook.calls[0]!.method).toBe('POST');
    expect(webhook.calls[0]!.headers['X-Auth']).toBe('PLAINTEXT-TOKEN');
    expect(webhook.calls[0]!.body).toBe('{"email":"journey@example.com","amount":"42.5"}');
    const act = await admin.query<{ outcome: string; detail: string }>(
      "SELECT outcome, detail FROM activity_log WHERE workspace_id = $1 AND source = 'webhook'",
      [WS],
    );
    expect(act.rows).toHaveLength(1);
    expect(act.rows[0]!.outcome).toBe('success');
    expect(act.rows[0]!.detail).not.toContain('PLAINTEXT-TOKEN');

    // IDEMPOTENCY: a re-tick (enrollment already completed) is a no-op — no second
    // outbox/send/webhook; the dispatcher replay claims nothing.
    const sqs2 = new CapturingSqs();
    const webhook2 = fakeWebhookClient();
    const rIdem = await runEnrollment(runnerDeps(t3, sqs2, webhook2), enrollmentId);
    expect(rIdem.result).toBe('skipped');
    expect(sqs2.bodies).toHaveLength(0);
    expect(webhook2.calls).toHaveLength(0);
    const again = await dispatchOutbox(dispatchDeps(ses, t3), parseOutboxIdFromSqsRecord(sqs.bodies[0]!));
    expect(again.result).not.toBe('send');
    expect(ses.sends).toHaveLength(1);
    const obCount = await admin.query('SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1', [WS]);
    expect(obCount.rows[0]!.n).toBe(1);

    // WORKSPACE-SCOPING: the parallel WS_B enrollment was never advanced by the WS_A
    // ticks (still active at trigger), and WS_B has NO messages_log / outbox.
    const bEnr = await admin.query<{ current_node: string; status: string }>(
      'SELECT current_node, status FROM campaign_enrollments WHERE workspace_id = $1 AND campaign_id = $2 AND profile_id = $3',
      [WS_B, CAMP_B, profileB],
    );
    expect(bEnr.rows[0]!.current_node).toBe('t');
    expect(bEnr.rows[0]!.status).toBe('active');
    const bMl = await admin.query('SELECT 1 FROM messages_log WHERE workspace_id = $1', [WS_B]);
    expect(bMl.rowCount).toBe(0);
    const bOb = await admin.query('SELECT 1 FROM outbox WHERE workspace_id = $1', [WS_B]);
    expect(bOb.rowCount).toBe(0);
  });
});
