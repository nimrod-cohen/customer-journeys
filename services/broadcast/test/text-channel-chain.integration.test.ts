import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SesEmailClient, SendEmailInput, SendEmailResult } from '@cdp/email';
import type { ChannelMessage, ChannelProvider, ChannelSendResult, Medium } from '@cdp/channels';
import {
  dispatchOutbox,
  parseOutboxIdFromSqsRecord,
  runStatementsInWorkspaceTx as dispatcherTx,
  type DispatchDeps,
} from '@cdp/service-dispatcher';
import { runBroadcast, type BroadcastDeps, type Reader } from '../src/send.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// MULTI-CHANNEL broadcasts: an sms/whatsapp broadcast → outbox → REAL dispatcher
// (routed to the MOCK channel provider, never SES) → messages_log(medium, provider
// id). A recipient WITHOUT a phone is SKIPPED (messages_log skipped row, batch
// never crashes). Idempotent (re-run sends nothing new). Workspace-scoped. Real
// Postgres; counting fakes for SES + the channel provider.
const RUN = hasDatabaseUrl();
const ws = '0c0d0ec0-0000-0000-0000-000000000001';

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

class CountingChannel implements ChannelProvider {
  public sends: ChannelMessage[] = [];
  constructor(readonly medium: 'sms' | 'whatsapp') {}
  async send(msg: ChannelMessage): Promise<ChannelSendResult> {
    this.sends.push(msg);
    const prefix = this.medium === 'sms' ? 'mock-sms' : 'mock-wa';
    return { providerMessageId: `${prefix}-${this.sends.length}` };
  }
}

class CapturingSqs {
  public bodies: string[] = [];
  async send(c: SendMessageCommand) {
    this.bodies.push((c as { input: { MessageBody?: string } }).input.MessageBody ?? '');
    return {};
  }
}

describe.skipIf(!RUN)('text-channel broadcast → dispatcher (mock provider, real Postgres)', () => {
  let admin: Pool;
  let segmentId: string;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    // status='active' so the medium-aware gate (active-only for text) passes; NO
    // verified sending domain on purpose — text must NOT need one.
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'WS-text','active')", [ws]);
    const s = await admin.query(
      "INSERT INTO segments (workspace_id, name, kind) VALUES ($1,'seg','manual') RETURNING id",
      [ws],
    );
    segmentId = s.rows[0].id;
    // Two recipients WITH a phone, one WITHOUT (must be skipped).
    const people: Array<[string, string | null]> = [
      ['withphone1@example.com', '+972500000001'],
      ['withphone2@example.com', '+972500000002'],
      ['nophone@example.com', null],
    ];
    for (const [email, phone] of people) {
      const attrs = phone ? JSON.stringify({ phone, first_name: 'Pat' }) : JSON.stringify({ first_name: 'Pat' });
      const p = await admin.query(
        'INSERT INTO profiles (workspace_id, external_id, email, attributes) VALUES ($1,$2,$3,$4::jsonb) RETURNING id',
        [ws, email, email, attrs],
      );
      await admin.query(
        "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
        [segmentId, p.rows[0].id, ws],
      );
    }
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
    await admin.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  async function runMediumBroadcast(medium: 'sms' | 'whatsapp'): Promise<{
    channel: CountingChannel;
    ses: CountingSes;
    outcomes: Awaited<ReturnType<typeof dispatchOutbox>>[];
  }> {
    const b = await admin.query(
      "INSERT INTO broadcasts (workspace_id, name, medium, text_body, audience_kind, audience_ref, status) VALUES ($1,'B',$2,$3,'segment',$4,'draft') RETURNING id",
      [ws, medium, 'Hi {{customer.first_name}} — your order is ready.', segmentId],
    );
    const broadcastId = b.rows[0].id;
    const reader: Reader = { query: (text, values) => admin.query(text, values as unknown[]) as never };
    const sqs = new CapturingSqs();
    const broadcastDeps: BroadcastDeps = {
      reader,
      sqs,
      runInWorkspaceTx: (w, st) => runStatementsInWorkspaceTx(admin, w, st),
      now: () => new Date('2026-06-22T12:00:00.000Z'),
      dispatchQueueUrl: 'https://sqs/dispatch',
    };
    const res = await runBroadcast(broadcastDeps, broadcastId);
    expect(res.result).toBe('sent');
    expect(res).toMatchObject({ recipientCount: 3 });

    const ses = new CountingSes();
    const channel = new CountingChannel(medium);
    const dispatchDeps: DispatchDeps = {
      reader,
      ses,
      resolveChannel: (m: Medium) => {
        expect(m).toBe(medium);
        return channel;
      },
      runInWorkspaceTx: (w, st) => dispatcherTx(admin, w, st),
      now: () => new Date('2026-06-22T12:00:00.000Z'),
      unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
      linkTrackingBaseUrl: 'https://api.cdp.example',
    };
    const outcomes = [];
    for (const body of sqs.bodies) {
      outcomes.push(await dispatchOutbox(dispatchDeps, parseOutboxIdFromSqsRecord(body)));
    }
    return { channel, ses, outcomes };
  }

  it('SMS broadcast sends via the mock provider, skips the no-phone recipient, never calls SES', async () => {
    const { channel, ses, outcomes } = await runMediumBroadcast('sms');
    expect(ses.sends).toHaveLength(0); // SES never touched for a text send
    expect(channel.sends).toHaveLength(2); // only the two recipients with a phone
    // body merge-rendered + sent to the PHONE
    expect(channel.sends[0].body).toBe('Hi Pat — your order is ready.');
    expect(channel.sends.map((m) => m.to).sort()).toEqual(['+972500000001', '+972500000002']);

    const sends = outcomes.filter((o) => o.result === 'send');
    const skips = outcomes.filter((o) => o.result === 'skip');
    expect(sends).toHaveLength(2);
    expect(skips).toHaveLength(1); // the no-phone recipient

    const ml = await admin.query<{ medium: string; ses_message_id: string | null; status: string }>(
      'SELECT medium, ses_message_id, status FROM messages_log WHERE workspace_id = $1 ORDER BY status',
      [ws],
    );
    expect(ml.rows).toHaveLength(3);
    const sent = ml.rows.filter((r) => r.status === 'sent');
    const skipped = ml.rows.filter((r) => r.status === 'skipped');
    expect(sent).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    for (const r of sent) {
      expect(r.medium).toBe('sms');
      expect(r.ses_message_id).toMatch(/^mock-sms-/);
    }
    expect(skipped[0].medium).toBe('sms');
    expect(skipped[0].ses_message_id).toBeNull();

    // Idempotent: a second dispatch of the same outbox ids sends nothing new
    // (outbox rows already terminal → noop), provider not called again.
    const obIds = (
      await admin.query<{ id: string }>("SELECT id FROM outbox WHERE workspace_id = $1", [ws])
    ).rows.map((r) => r.id);
    const ses2 = new CountingSes();
    const channel2 = new CountingChannel('sms');
    const deps2: DispatchDeps = {
      reader: { query: (text, values) => admin.query(text, values as unknown[]) as never },
      ses: ses2,
      resolveChannel: () => channel2,
      runInWorkspaceTx: (w, st) => dispatcherTx(admin, w, st),
      now: () => new Date('2026-06-22T12:05:00.000Z'),
      unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
      linkTrackingBaseUrl: 'https://api.cdp.example',
    };
    for (const id of obIds) await dispatchOutbox(deps2, id);
    expect(channel2.sends).toHaveLength(0);
    const ml2 = await admin.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1', [ws]);
    expect(ml2.rows[0].n).toBe(3); // unchanged

    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
  });

  it('WhatsApp broadcast mirrors SMS (mock provider, medium=whatsapp in messages_log)', async () => {
    const { channel, ses, outcomes } = await runMediumBroadcast('whatsapp');
    expect(ses.sends).toHaveLength(0);
    expect(channel.sends).toHaveLength(2);
    expect(outcomes.filter((o) => o.result === 'send')).toHaveLength(2);
    expect(outcomes.filter((o) => o.result === 'skip')).toHaveLength(1);

    const ml = await admin.query<{ medium: string; ses_message_id: string | null }>(
      "SELECT medium, ses_message_id FROM messages_log WHERE workspace_id = $1 AND status = 'sent'",
      [ws],
    );
    expect(ml.rows).toHaveLength(2);
    for (const r of ml.rows) {
      expect(r.medium).toBe('whatsapp');
      expect(r.ses_message_id).toMatch(/^mock-wa-/);
    }

    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
  });
});
