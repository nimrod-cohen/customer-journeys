// POST /internal/mail-events — the endpoint our mail server's agent posts raw
// bounces and spam reports to. REAL Postgres, through the REAL Hono app.
//
// The properties that matter here are security ones:
//   - the shared bearer only gets a caller through the door; the workspace comes
//     from a VERIFIED VERP token resolved against messages_log, never the body
//   - a forged token acts on nothing
//   - a transient failure is recorded but NEVER suppresses
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { verpReturnPath, unsubscribeLinkSecret } from '@cdp/email';
import { createApp } from '../src/index.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const WS = '0c0d0f22-0000-4000-8000-000000000a01';
const WS_OTHER = '0c0d0f22-0000-4000-8000-000000000a02';
const PROFILE = '0c0d0f22-0000-4000-8000-0000000000c1';
const EMAIL = 'bouncer@example.com';
const MSG = '0c0d0f22-0000-4000-8000-0000000000f1';
const SECRET = 'test-mail-agent-secret';

function dsn(returnPath: string, status: string, action = 'failed'): string {
  return [
    'From: MAILER-DAEMON@mail.journeys.on-grow.com',
    `X-Original-To: ${returnPath}`,
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    '--B',
    'Content-Type: message/delivery-status',
    '',
    `Final-Recipient: rfc822; ${EMAIL}`,
    `Action: ${action}`,
    `Status: ${status}`,
    '',
    '--B--',
  ].join('\n');
}

describeMaybe('POST /internal/mail-events (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let prevSecret: string | undefined;

  const post = (body: unknown, auth = `Bearer ${SECRET}`) =>
    app.request('/internal/mail-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(body),
    });

  const suppressionReason = async (): Promise<string | null> => {
    const { rows } = await pool.query<{ reason: string }>(
      'SELECT reason FROM suppressions WHERE workspace_id=$1 AND email=$2',
      [WS, EMAIL],
    );
    return rows[0]?.reason ?? null;
  };

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_OTHER]) {
      await pool.query('DELETE FROM email_events WHERE workspace_id=$1', [ws]);
      await pool.query('DELETE FROM suppressions WHERE workspace_id=$1', [ws]);
      await pool.query('DELETE FROM messages_log WHERE workspace_id=$1', [ws]);
      await pool.query('DELETE FROM profiles WHERE workspace_id=$1', [ws]);
      await pool.query('DELETE FROM workspaces WHERE id=$1', [ws]);
    }
    await pool.query('DELETE FROM global_hard_bounces WHERE email=$1', [EMAIL]);
  }

  beforeAll(async () => {
    prevSecret = process.env.MAIL_AGENT_SECRET;
    process.env.MAIL_AGENT_SECRET = SECRET;
    pool = adminPool();
    app = createApp({ pool });
    await cleanup();
    for (const ws of [WS, WS_OTHER]) {
      await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await pool.query("INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,$3)", [PROFILE, WS, EMAIL]);
    // The send this bounce refers to. Our own Message-ID is the correlation key.
    await pool.query(
      "INSERT INTO messages_log (workspace_id, profile_id, ses_message_id, status) VALUES ($1,$2,$3,'sent')",
      [WS, PROFILE, MSG],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
    if (prevSecret === undefined) delete process.env.MAIL_AGENT_SECRET;
    else process.env.MAIL_AGENT_SECRET = prevSecret;
  });

  it('rejects a request with no or wrong bearer', async () => {
    expect((await post({ raw: 'x' }, 'Bearer nope')).status).toBe(401);
    expect((await post({ raw: 'x' }, '')).status).toBe(401);
  });

  it('rejects a body with no raw message', async () => {
    expect((await post({})).status).toBe(400);
  });

  it('suppresses on a permanent failure and records the event', async () => {
    const rp = verpReturnPath('bounce.journeys.on-grow.com', unsubscribeLinkSecret(), MSG);
    const res = await post({ raw: dsn(rp, '5.1.1') });
    expect(res.status).toBe(200);
    expect((await res.json()).action).toBe('suppress');

    expect(await suppressionReason()).toBe('hard_bounce');
    const ev = await pool.query('SELECT type FROM email_events WHERE workspace_id=$1', [WS]);
    expect(ev.rows[0]?.type).toBe('bounce');
    // An invalid mailbox is invalid everywhere — the deliberate cross-workspace list.
    const g = await pool.query('SELECT 1 FROM global_hard_bounces WHERE email=$1', [EMAIL]);
    expect(g.rowCount).toBe(1);
  });

  it('is idempotent when the same report arrives twice', async () => {
    const rp = verpReturnPath('bounce.journeys.on-grow.com', unsubscribeLinkSecret(), MSG);
    await post({ raw: dsn(rp, '5.1.1') });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM email_events WHERE workspace_id=$1', [WS]);
    expect(rows[0].n).toBe(1);
  });

  it('does NOT suppress a transient failure', async () => {
    await pool.query('DELETE FROM suppressions WHERE workspace_id=$1', [WS]);
    const rp = verpReturnPath('bounce.journeys.on-grow.com', unsubscribeLinkSecret(), MSG);
    const res = await post({ raw: dsn(rp, '4.2.2', 'delayed') });
    expect((await res.json()).action).toBe('record');
    expect(await suppressionReason()).toBeNull(); // still mailable — the MTA is retrying
  });

  // Security: a forged bounce address must not be able to suppress anyone.
  it('ignores a token signed with the wrong secret', async () => {
    await pool.query('DELETE FROM suppressions WHERE workspace_id=$1', [WS]);
    const forged = verpReturnPath('bounce.journeys.on-grow.com', 'attacker-secret', MSG);
    const res = await post({ raw: dsn(forged, '5.1.1') });
    expect(res.status).toBe(200);
    expect((await res.json()).action).toBe('ignored');
    expect(await suppressionReason()).toBeNull();
  });

  it('ignores a report whose message we never sent', async () => {
    const unknown = '0c0d0f22-0000-4000-8000-0000000000ff';
    const rp = verpReturnPath('bounce.journeys.on-grow.com', unsubscribeLinkSecret(), unknown);
    const res = await post({ raw: dsn(rp, '5.1.1') });
    expect((await res.json()).action).toBe('ignored');
  });

  it('never writes into another workspace', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM suppressions WHERE workspace_id=$1', [WS_OTHER]);
    expect(rows[0].n).toBe(0);
  });
});
