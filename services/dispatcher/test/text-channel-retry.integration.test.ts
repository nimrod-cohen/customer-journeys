import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { dispatchOutbox, type DispatchDeps } from '../src/dispatch.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import { ChannelSendError, type ChannelProvider } from '@cdp/channels';
import type { SendEmailInput, SesEmailClient } from '@cdp/email';

// A text-channel provider FAILURE must be classified: a TRANSIENT failure
// (ChannelSendError retryable=true — network/5xx that survived the provider's own
// retries) resets the claim so the outbox/DLQ machinery re-drives it (never
// silently dropped); a PERMANENT failure (retryable=false — 4xx / rejection)
// records a 'failed' messages_log row and marks the outbox row done (terminal).
const RUN = hasDatabaseUrl();
const ws = '0c0d0ec2-0000-4000-8000-000000000001';

function makeSes(): SesEmailClient {
  return { async sendEmail(_i: SendEmailInput) { return { sesMessageId: 'x' }; } } as SesEmailClient;
}

/** A provider that always throws the given error. */
function throwingChannel(err: unknown): ChannelProvider {
  return { async send() { throw err; } };
}

describe.skipIf(!RUN)('dispatcher text-channel retry classification (real Postgres)', () => {
  let admin: Pool;
  let profileId: string;
  let broadcastId: string;

  const depsWith = (provider: ChannelProvider): DispatchDeps => ({
    reader: admin,
    ses: makeSes(),
    resolveChannel: () => provider,
    runInWorkspaceTx: (workspaceId, stmts) => runStatementsInWorkspaceTx(admin, workspaceId, stmts),
    now: () => new Date('2026-06-10T12:00:00.000Z'),
    unsubscribeBaseUrl: 'https://api.test/unsubscribe',
    linkTrackingBaseUrl: 'https://api.test',
  });

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'WS-retry','active')", [ws]);
    const p = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email, attributes) VALUES ($1,'r','r@example.com',$2::jsonb) RETURNING id",
      [ws, JSON.stringify({ phone: '+972500000001' })],
    );
    profileId = p.rows[0].id;
    const b = await admin.query(
      "INSERT INTO broadcasts (workspace_id, name, medium, text_body, audience_kind, status) VALUES ($1,'B','sms','Hi','segment','draft') RETURNING id",
      [ws],
    );
    broadcastId = b.rows[0].id;
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
  });
  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  async function queueSms(): Promise<string> {
    const o = await admin.query(
      "INSERT INTO outbox (workspace_id, profile_id, status, payload) VALUES ($1,$2,'pending',$3::jsonb) RETURNING id",
      [ws, profileId, JSON.stringify({ broadcast_id: broadcastId, medium: 'sms' })],
    );
    return o.rows[0].id as string;
  }
  const outboxStatus = async (id: string): Promise<string> =>
    (await admin.query('SELECT status FROM outbox WHERE id = $1', [id])).rows[0]?.status as string;
  const failedRows = async (): Promise<number> =>
    (await admin.query("SELECT count(*)::int AS c FROM messages_log WHERE workspace_id = $1 AND status = 'failed'", [ws]))
      .rows[0].c as number;

  it('a TRANSIENT failure resets the claim (retryable-failure, no failed row)', async () => {
    const id = await queueSms();
    const out = await dispatchOutbox(depsWith(throwingChannel(new ChannelSendError('019 SMS: HTTP 503', true))), id);
    expect(out.result).toBe('retryable-failure');
    // Claim reset → the row is pending again for the next attempt; no 'failed' row.
    expect(await outboxStatus(id)).toBe('pending');
    expect(await failedRows()).toBe(0);
  });

  it('a PERMANENT failure is terminal (skip, failed row, outbox sent)', async () => {
    const id = await queueSms();
    const out = await dispatchOutbox(depsWith(throwingChannel(new ChannelSendError('019 SMS: HTTP 400', false))), id);
    expect(out.result).toBe('skip');
    expect(await outboxStatus(id)).toBe('sent');
    expect(await failedRows()).toBe(1);
  });
});
