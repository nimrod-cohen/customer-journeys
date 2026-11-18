// POST /automations/:id/send-nodes/:nodeId/test-send — QA a journey's message with a
// REAL customer's data, delivered to the person testing it (real Postgres, SES mocked,
// text channels on the deterministic mock provider).
//
// What must hold:
//   - {{customer.*}} comes from the chosen profile, {{event.*}} from the chosen event,
//     {{journey.*}} is empty; the subject / text body carries a "[TEST] " prefix;
//   - it goes to the TESTER, never the customer, and leaves no trace on the customer:
//     no enrollment, no outbox row, no messages_log row, no profile write;
//   - consent/suppression is judged on the TEST recipient's address;
//   - the email envelope + verified-domain gates still apply;
//   - a foreign automation / profile / event is a 404 (inv.2).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { unpackSubscriptionToken, unsubscribeLinkSecret, type SesEmailClient, type SendEmailInput, type SendEmailResult } from '@cdp/email';
import { tokenFor, call } from './seed.js';
import { makePgLookups, makeLocalDeps } from '../src/index.js';
import type { DispatchEnv } from '../src/index.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// Unused prefix: 0c0d7e57.
const WS = '0c0d7e57-0000-4000-8000-000000000a01';
const WS_B = '0c0d7e57-0000-4000-8000-000000000a02';
const USER = '0c0d7e57-0000-4000-8000-0000000000b1';
const DOMAIN = '0c0d7e57-0000-4000-8000-0000000000d1';
const SENDER = '0c0d7e57-0000-4000-8000-0000000000f1';
const COPY = '0c0d7e57-0000-4000-8000-0000000000e1';
const COPY_NO_SENDER = '0c0d7e57-0000-4000-8000-0000000000e2';
const EVT = '0c0d7e57-0000-4000-8000-0000000000c1';
const EVT_OTHER = '0c0d7e57-0000-4000-8000-0000000000c2';
const EVT_B = '0c0d7e57-0000-4000-8000-0000000000c3';
const TESTER = 'tester@agency.test';

class CapturingSes implements SesEmailClient {
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

const def = () => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'event', eventType: 'order_placed', next: 'mail' },
    mail: { type: 'action', kind: 'send', template_id: COPY, next: 'sms' },
    sms: {
      type: 'action',
      kind: 'send',
      medium: 'sms',
      text_body: 'Hi {{customer.first_name}}, order {{event.order.id}}{{journey.coupon}}',
      next: 'bare',
    },
    bare: { type: 'action', kind: 'send', template_id: COPY_NO_SENDER, next: 'x' },
    x: { type: 'exit' },
  },
});

describeMaybe('automation step test send (real Postgres)', () => {
  let pool: Pool;
  let env: DispatchEnv;
  const ses = new CapturingSes();
  let automation = '';
  let automationB = '';
  let customer = '';
  let otherCustomer = '';
  let customerB = '';

  const tok = () => tokenFor(USER, WS);
  const testSend = (node: string, body: Record<string, unknown>, id = automation) =>
    call(env, 'POST', `/automations/${id}/send-nodes/${node}/test-send`, { token: tok(), body });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      for (const t of [
        'activity_log',
        'messages_log',
        'usage_counters',
        'outbox',
        'automation_enrollments',
        'automations',
        'events',
        'channel_optouts',
        'suppressions',
        'email_templates',
        'domain_senders',
        'sending_domains',
        'profiles',
        'workspace_users',
      ]) {
        await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [ws]);
      }
      await pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
  }

  beforeAll(async () => {
    pool = adminPool();
    const deps = makeLocalDeps(pool);
    env = { pool, lookups: makePgLookups(pool), deps: { ...deps, onboarding: { ...deps.onboarding, ses } } };
    await cleanup();
    await pool.query('INSERT INTO users (id, email) VALUES ($1,$2)', [USER, TESTER]);
    for (const ws of [WS, WS_B]) {
      await pool.query(
        "INSERT INTO workspaces (id, name, status, settings) VALUES ($1,'W','active','{\"default_phone_country\":\"IL\"}'::jsonb)",
        [ws],
      );
      await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'marketer')", [ws, USER]);
    }
    await pool.query("INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'mail.acme.com',true)", [DOMAIN, WS]);
    await pool.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'mail.acme.com','Acme','team@mail.acme.com')",
      [SENDER, WS],
    );
    await pool.query(
      `INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html, kind, subject, sender_id, to_address) VALUES
         ($1,$3,'Copy','<m/>','<p>Hi {{customer.first_name}}, order {{event.order.id}}[{{journey.coupon}}] {{unsubscribe}}</p>','copy','Your order {{event.order.id}}',$4,'{{customer.email}}'),
         ($2,$3,'Bare','<m/>','<p>x</p>','copy','Subj',NULL,'{{customer.email}}')`,
      [COPY, COPY_NO_SENDER, WS, SENDER],
    );
    const mk = async (ws: string, email: string, phone: string | null, first: string) =>
      (
        await pool.query<{ id: string }>(
          'INSERT INTO profiles (workspace_id, email, phone, attributes) VALUES ($1,$2,$3,$4::jsonb) RETURNING id',
          [ws, email, phone, JSON.stringify({ first_name: first })],
        )
      ).rows[0]!.id;
    customer = await mk(WS, 'real.customer@example.com', '+972541234567', 'Dana');
    otherCustomer = await mk(WS, 'other@example.com', null, 'Omer');
    customerB = await mk(WS_B, 'b@example.com', null, 'Bea');
    await pool.query(
      `INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload) VALUES
         ($1,$4,$5,'order_placed',now(),'{"order":{"id":"A-77"}}'::jsonb),
         ($2,$4,$6,'order_placed',now(),'{"order":{"id":"OTHER"}}'::jsonb),
         ($3,$7,$8,'order_placed',now(),'{"order":{"id":"B"}}'::jsonb)`,
      [EVT, EVT_OTHER, EVT_B, WS, customer, otherCustomer, WS_B, customerB],
    );
    // The automation has a published definition AND a draft; the test sends the DRAFT.
    automation = (
      await pool.query<{ id: string }>(
        "INSERT INTO automations (workspace_id, name, definition, draft_definition, status) VALUES ($1,'A',$2::jsonb,$3::jsonb,'active') RETURNING id",
        [WS, JSON.stringify({ startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 'x' }, x: { type: 'exit' } } }), JSON.stringify(def())],
      )
    ).rows[0]!.id;
    automationB = (
      await pool.query<{ id: string }>(
        "INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,'B',$2::jsonb,'draft') RETURNING id",
        [WS_B, JSON.stringify(def())],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function customerTrace(): Promise<Record<string, number>> {
    const n = async (sql: string) => (await pool.query<{ n: number }>(sql, [WS])).rows[0]!.n;
    return {
      outbox: await n('SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1'),
      enrollments: await n('SELECT count(*)::int AS n FROM automation_enrollments WHERE workspace_id = $1'),
      messages: await n('SELECT count(*)::int AS n FROM messages_log WHERE workspace_id = $1'),
      profiles: await n('SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1'),
    };
  }

  it('renders the email with the real customer + event, sends it to the signed-in user with [TEST]', async () => {
    const before = await customerTrace();
    const profileBefore = await pool.query('SELECT attributes, updated_at FROM profiles WHERE id = $1', [customer]);
    ses.sends = [];

    const res = await testSend('mail', { profile_id: customer, event_id: EVT });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: true, to: TESTER, medium: 'email' });

    expect(ses.sends).toHaveLength(1);
    const sent = ses.sends[0]!;
    expect(sent.to).toBe(TESTER);
    expect(sent.subject).toBe('[TEST] Your order A-77');
    expect(sent.from).toBe('Acme <team@mail.acme.com>');
    expect(sent.html).toContain('Hi Dana, order A-77[]');
    // The unsubscribe link is a REAL, clickable preference-center link — but signed
    // for the TESTER's address, never the customer's (clicking it in a test must not
    // opt the customer out), and with no automation attribution (no metric).
    const href = /href="([^"]*manage-subscription[^"]*)"/.exec(sent.html)?.[1]?.replace(/&amp;/g, '&');
    expect(href).toBeTruthy();
    const t = new URL(href!).searchParams.get('t')!;
    expect(unpackSubscriptionToken(unsubscribeLinkSecret(), t)).toMatchObject({ workspaceId: WS, email: TESTER });
    expect(new URL(href!).searchParams.get('c')).toBeNull();
    expect(sent.headers?.['List-Unsubscribe']).toBeUndefined();

    // No trace on the customer.
    expect(await customerTrace()).toEqual(before);
    const profileAfter = await pool.query('SELECT attributes, updated_at FROM profiles WHERE id = $1', [customer]);
    expect(profileAfter.rows[0]).toEqual(profileBefore.rows[0]);

    // Logged as a TEST send, not as a send to the customer.
    const log = await pool.query<{ profile_id: string | null; source: string; type: string; detail: string }>(
      "SELECT profile_id, source, type, detail FROM activity_log WHERE workspace_id = $1 AND source = 'test_send'",
      [WS],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]!.profile_id).toBeNull();
    expect(log.rows[0]!.type).toBe('email');
    expect(log.rows[0]!.detail).toContain(TESTER);
    expect(log.rows[0]!.detail).toContain('real.customer@example.com');
  });

  it('sends to an explicit address instead of the signed-in user', async () => {
    ses.sends = [];
    const res = await testSend('mail', { profile_id: customer, event_id: EVT, to: 'qa@agency.test' });
    expect(res.status).toBe(200);
    expect(ses.sends[0]!.to).toBe('qa@agency.test');
  });

  it('without an event, {{event.*}} renders empty', async () => {
    ses.sends = [];
    const res = await testSend('mail', { profile_id: customer });
    expect(res.status).toBe(200);
    expect(ses.sends[0]!.subject).toBe('[TEST] Your order ');
  });

  it('sends an SMS to the entered phone with [TEST] prefixed, no trace on the customer', async () => {
    const before = await customerTrace();
    const res = await testSend('sms', { profile_id: customer, event_id: EVT, to: '054-9998887' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sent: true,
      medium: 'sms',
      to: '+972549998887',
      body: '[TEST] Hi Dana, order A-77',
    });
    expect(await customerTrace()).toEqual(before);
  });

  it('a text test send needs a phone number', async () => {
    const res = await testSend('sms', { profile_id: customer });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/phone/i);
  });

  it('judges consent on the TEST recipient, not the customer', async () => {
    // The customer is suppressed — the test still goes, because it is not to them.
    await pool.query("INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,'real.customer@example.com','unsubscribe')", [WS]);
    ses.sends = [];
    const ok = await testSend('mail', { profile_id: customer });
    expect((ok.body as { sent: boolean }).sent).toBe(true);

    // The tester's address is a hard bounce — refused.
    await pool.query("INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,'dead@agency.test','hard_bounce')", [WS]);
    ses.sends = [];
    const blocked = await testSend('mail', { profile_id: customer, to: 'dead@agency.test' });
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ sent: false });
    expect(ses.sends).toHaveLength(0);

    // The tester's address unsubscribed — consent is honoured for them too.
    await pool.query("INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,'gone@agency.test','unsubscribe')", [WS]);
    const unsub = await testSend('mail', { profile_id: customer, to: 'gone@agency.test' });
    expect(unsub.body).toMatchObject({ sent: false, reason: expect.stringMatching(/unsubscribed/) });
    expect(ses.sends).toHaveLength(0);
  });

  it('a text test to an opted-out phone is refused', async () => {
    await pool.query(
      "INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'sms_whatsapp')",
      [WS, customer],
    );
    // The customer's own phone, which opted out of texts.
    const res = await testSend('sms', { profile_id: otherCustomer, to: '+972541234567' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: false });
    await pool.query('DELETE FROM channel_optouts WHERE workspace_id = $1', [WS]);
  });

  it('the envelope gate applies: an email with no sender is a 409', async () => {
    const res = await testSend('bare', { profile_id: customer });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/from/i);
  });

  it('the verified-domain gate applies', async () => {
    await pool.query('UPDATE sending_domains SET verified = false WHERE id = $1', [DOMAIN]);
    try {
      const res = await testSend('mail', { profile_id: otherCustomer });
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toMatch(/verified sending domain/i);
    } finally {
      await pool.query('UPDATE sending_domains SET verified = true WHERE id = $1', [DOMAIN]);
    }
  });

  it('a foreign automation, profile or event is a 404; so is another customer\'s event', async () => {
    expect((await testSend('mail', { profile_id: customer }, automationB)).status).toBe(404);
    expect((await testSend('mail', { profile_id: customerB })).status).toBe(404);
    expect((await testSend('mail', { profile_id: customer, event_id: EVT_B })).status).toBe(404);
    expect((await testSend('mail', { profile_id: customer, event_id: EVT_OTHER })).status).toBe(404);
    expect((await testSend('nope', { profile_id: customer })).status).toBe(404);
  });

  it('a step that is not a send step is a 400; a missing profile_id is a 400', async () => {
    expect((await testSend('x', { profile_id: customer })).status).toBe(400);
    expect((await testSend('mail', {})).status).toBe(400);
  });
});
