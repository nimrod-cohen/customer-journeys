import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { dispatchOutbox, type DispatchDeps } from '../src/dispatch.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import type { SendEmailInput, SesEmailClient } from '@cdp/email';
import type { ChannelMessage, ChannelProvider, Medium } from '@cdp/channels';

// CLAUDE.md topic-subscriptions — the HEART of the feature. The dispatcher SKIPS
// a recipient (records the skip in messages_log, never crashes the batch) when:
//   (a) hard-suppressed (existing),
//   (b) opted out of the message's MEDIUM GROUP (channel_optouts), OR
//   (c) the message has a topic_id AND the profile unsubscribed from that topic.
// Proven for BOTH email and sms/whatsapp, workspace-scoped, via the REAL
// dispatchOutbox over real Postgres. SES + the channel provider are COUNTING
// fakes — a skip means ZERO provider calls and a 'skipped' messages_log row.
const RUN = hasDatabaseUrl();

// Fresh, unused workspace-id prefix (0c0d0ec1 — grep confirmed unused).
const ws = '0c0d0ec1-0000-4000-8000-000000000001';
const wsOther = '0c0d0ec1-0000-4000-8000-0000000000ff';

function makeSes(): SesEmailClient & { calls: SendEmailInput[] } {
  const calls: SendEmailInput[] = [];
  return {
    calls,
    async sendEmail(input: SendEmailInput) {
      calls.push(input);
      return { sesMessageId: `ses-${calls.length}` };
    },
  } as SesEmailClient & { calls: SendEmailInput[] };
}

function makeChannel(): { resolve: (m: Medium) => ChannelProvider; calls: ChannelMessage[] } {
  const calls: ChannelMessage[] = [];
  const provider: ChannelProvider = {
    async send(message: ChannelMessage) {
      calls.push(message);
      return { providerMessageId: `prov-${calls.length}` };
    },
  };
  return { resolve: () => provider, calls };
}

describe.skipIf(!RUN)('dispatcher topic + medium-group gating (real Postgres)', () => {
  let admin: Pool;
  let ses: ReturnType<typeof makeSes>;
  let channel: ReturnType<typeof makeChannel>;
  let deps: DispatchDeps;
  let profileId: string;
  let otherProfileId: string;
  let topicId: string;
  let templateId: string;
  let senderId: string;

  const baseDeps = (): DispatchDeps => ({
    reader: admin,
    ses,
    resolveChannel: channel.resolve,
    runInWorkspaceTx: (workspaceId, stmts) => runStatementsInWorkspaceTx(admin, workspaceId, stmts),
    now: () => new Date('2026-06-10T12:00:00.000Z'),
    unsubscribeBaseUrl: 'https://api.test/unsubscribe',
    linkTrackingBaseUrl: 'https://api.test',
  });

  // Queue ONE outbox row for a (profile, broadcast) and dispatch it.
  async function dispatchEmail(opts: {
    profileId: string;
    broadcastId: string;
  }): Promise<{ result: string; reason?: string }> {
    const o = await admin.query(
      "INSERT INTO outbox (workspace_id, profile_id, template_id, status, payload) VALUES ($1,$2,$3,'pending',$4::jsonb) RETURNING id",
      [ws, opts.profileId, templateId, JSON.stringify({ broadcast_id: opts.broadcastId })],
    );
    return dispatchOutbox(deps, o.rows[0].id);
  }
  async function dispatchSms(opts: {
    profileId: string;
    broadcastId: string;
    medium: 'sms' | 'whatsapp';
  }): Promise<{ result: string; reason?: string }> {
    const o = await admin.query(
      "INSERT INTO outbox (workspace_id, profile_id, status, payload) VALUES ($1,$2,'pending',$3::jsonb) RETURNING id",
      [ws, opts.profileId, JSON.stringify({ broadcast_id: opts.broadcastId, medium: opts.medium })],
    );
    return dispatchOutbox(deps, o.rows[0].id);
  }

  // Create a broadcast row of a given medium/topic; returns its id.
  async function makeBroadcast(opts: {
    medium: Medium;
    topicId?: string | null;
    textBody?: string;
  }): Promise<string> {
    const r = await admin.query(
      `INSERT INTO broadcasts (workspace_id, name, medium, text_body, template_id, topic_id, audience_kind, audience_ref, status)
       VALUES ($1,'B',$2,$3,$4,$5,'segment',$1,'sending') RETURNING id`,
      [ws, opts.medium, opts.textBody ?? null, opts.medium === 'email' ? templateId : null, opts.topicId ?? null],
    );
    return r.rows[0].id;
  }

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const w of [ws, wsOther]) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
      // A verified sending domain so the email gate passes.
      await admin.query(
        "INSERT INTO sending_domains (workspace_id, domain, verified) VALUES ($1,'mail.test',true)",
        [w],
      );
    }
    // Sender + template (email instance) so the email send path is complete.
    const snd = await admin.query(
      "INSERT INTO domain_senders (workspace_id, domain, name, email) VALUES ($1,'mail.test','Acme','hi@mail.test') RETURNING id",
      [ws],
    );
    senderId = snd.rows[0].id;
    const tpl = await admin.query(
      `INSERT INTO email_templates (workspace_id, name, kind, mjml, compiled_html, subject, sender_id, to_address)
       VALUES ($1,'T','copy','<mjml></mjml>','<p>hi</p>','Hello',$2,'{{customer.email}}') RETURNING id`,
      [ws, senderId],
    );
    templateId = tpl.rows[0].id;

    const p = await admin.query(
      "INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,'r@example.com', '{\"phone\":\"+15551230000\"}'::jsonb) RETURNING id",
      [ws],
    );
    profileId = p.rows[0].id;
    const p2 = await admin.query(
      "INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,'other@example.com', '{\"phone\":\"+15559990000\"}'::jsonb) RETURNING id",
      [ws],
    );
    otherProfileId = p2.rows[0].id;
    const t = await admin.query("INSERT INTO topics (workspace_id, name) VALUES ($1,'News') RETURNING id", [ws]);
    topicId = t.rows[0].id;
  });

  beforeEach(async () => {
    ses = makeSes();
    channel = makeChannel();
    deps = baseDeps();
    // Reset opt-out / subscription / send state between cases.
    await admin.query('DELETE FROM channel_optouts WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM topic_subscriptions WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const w of [ws, wsOther]) {
      await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM channel_optouts WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM topic_subscriptions WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM domain_senders WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM sending_domains WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM topics WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  const skippedRows = async () =>
    (await admin.query("SELECT count(*)::int n FROM messages_log WHERE workspace_id=$1 AND status='skipped'", [ws]))
      .rows[0].n as number;

  // ── EMAIL ──────────────────────────────────────────────────────────────────
  it('email: no opt-outs → SENDS (baseline)', async () => {
    const bc = await makeBroadcast({ medium: 'email', topicId });
    const r = await dispatchEmail({ profileId, broadcastId: bc });
    expect(r.result).toBe('send');
    expect(ses.calls.length).toBe(1);
  });

  it('email: hard suppression → SKIP (no SES call)', async () => {
    await admin.query("INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,'r@example.com','unsubscribe')", [ws]);
    const bc = await makeBroadcast({ medium: 'email', topicId });
    const r = await dispatchEmail({ profileId, broadcastId: bc });
    expect(r.result).toBe('skip');
    expect(ses.calls.length).toBe(0);
  });

  it('email: medium-group opt-out (email) → SKIP', async () => {
    await admin.query(
      "INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'email')",
      [ws, profileId],
    );
    const bc = await makeBroadcast({ medium: 'email', topicId });
    const r = await dispatchEmail({ profileId, broadcastId: bc });
    expect(r.result).toBe('skip');
    expect(ses.calls.length).toBe(0);
  });

  it('email: topic opt-out → SKIP', async () => {
    await admin.query(
      "INSERT INTO topic_subscriptions (workspace_id, profile_id, topic_id, subscribed) VALUES ($1,$2,$3,false)",
      [ws, profileId, topicId],
    );
    const bc = await makeBroadcast({ medium: 'email', topicId });
    const r = await dispatchEmail({ profileId, broadcastId: bc });
    expect(r.result).toBe('skip');
    expect(ses.calls.length).toBe(0);
  });

  it('email: topic opt-out does NOT block an UNTOPICED broadcast', async () => {
    await admin.query(
      "INSERT INTO topic_subscriptions (workspace_id, profile_id, topic_id, subscribed) VALUES ($1,$2,$3,false)",
      [ws, profileId, topicId],
    );
    const bc = await makeBroadcast({ medium: 'email', topicId: null });
    const r = await dispatchEmail({ profileId, broadcastId: bc });
    expect(r.result).toBe('send');
    expect(ses.calls.length).toBe(1);
  });

  // ── SMS / WhatsApp ───────────────────────────────────────────────────────
  it('sms: no opt-outs → SENDS via the channel provider (baseline)', async () => {
    const bc = await makeBroadcast({ medium: 'sms', topicId, textBody: 'hi {{customer.email}}' });
    const r = await dispatchSms({ profileId, broadcastId: bc, medium: 'sms' });
    expect(r.result).toBe('send');
    expect(channel.calls.length).toBe(1);
    expect(ses.calls.length).toBe(0);
  });

  it('sms: medium-group opt-out (sms_whatsapp) → SKIP (no provider call)', async () => {
    await admin.query(
      "INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'sms_whatsapp')",
      [ws, profileId],
    );
    const bc = await makeBroadcast({ medium: 'sms', topicId, textBody: 'hi' });
    const r = await dispatchSms({ profileId, broadcastId: bc, medium: 'sms' });
    expect(r.result).toBe('skip');
    expect(channel.calls.length).toBe(0);
  });

  it('whatsapp: same medium group → an sms_whatsapp opt-out also blocks WhatsApp', async () => {
    await admin.query(
      "INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'sms_whatsapp')",
      [ws, profileId],
    );
    const bc = await makeBroadcast({ medium: 'whatsapp', topicId, textBody: 'hi' });
    const r = await dispatchSms({ profileId, broadcastId: bc, medium: 'whatsapp' });
    expect(r.result).toBe('skip');
    expect(channel.calls.length).toBe(0);
  });

  it('sms: topic opt-out → SKIP', async () => {
    await admin.query(
      "INSERT INTO topic_subscriptions (workspace_id, profile_id, topic_id, subscribed) VALUES ($1,$2,$3,false)",
      [ws, profileId, topicId],
    );
    const bc = await makeBroadcast({ medium: 'sms', topicId, textBody: 'hi' });
    const r = await dispatchSms({ profileId, broadcastId: bc, medium: 'sms' });
    expect(r.result).toBe('skip');
    expect(channel.calls.length).toBe(0);
  });

  // ── PARTIAL opt-out: the OTHER channel stays sendable ────────────────────
  it('PARTIAL: an email-group opt-out leaves SMS sendable (the user requirement)', async () => {
    await admin.query(
      "INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'email')",
      [ws, profileId],
    );
    // Email is blocked…
    const ebc = await makeBroadcast({ medium: 'email', topicId: null });
    const er = await dispatchEmail({ profileId, broadcastId: ebc });
    expect(er.result).toBe('skip');
    expect(ses.calls.length).toBe(0);
    // …but SMS still goes out (different medium group).
    const sbc = await makeBroadcast({ medium: 'sms', topicId: null, textBody: 'hi' });
    const sr = await dispatchSms({ profileId, broadcastId: sbc, medium: 'sms' });
    expect(sr.result).toBe('send');
    expect(channel.calls.length).toBe(1);
  });

  it('a skip is recorded as a messages_log skipped row (batch never crashes)', async () => {
    await admin.query(
      "INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'sms_whatsapp')",
      [ws, profileId],
    );
    const bc = await makeBroadcast({ medium: 'sms', topicId: null, textBody: 'hi' });
    await dispatchSms({ profileId, broadcastId: bc, medium: 'sms' });
    expect(await skippedRows()).toBeGreaterThanOrEqual(1);
  });

  it('WORKSPACE-SCOPED: another profile without an opt-out still sends', async () => {
    await admin.query(
      "INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'email')",
      [ws, profileId],
    );
    const bc = await makeBroadcast({ medium: 'email', topicId: null });
    const r = await dispatchEmail({ profileId: otherProfileId, broadcastId: bc });
    expect(r.result).toBe('send');
    expect(ses.calls.length).toBe(1);
  });
});
