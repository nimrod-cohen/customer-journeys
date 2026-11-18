// POST /internal/mail-deliveries — the agent posts Postfix log lines; each
// successful handoff becomes ONE `delivery` email_event, attributed through the
// signed VERP token (never the body). REAL Postgres, through the REAL Hono app.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { verpReturnPath, unsubscribeLinkSecret } from '@cdp/email';
import { createApp } from '../src/index.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const WS = '0c0d0f44-0000-4000-8000-000000000a01';
const PROFILE = '0c0d0f44-0000-4000-8000-0000000000c1';
const MSG = '0c0d0f44-0000-4000-8000-0000000000f1';
const SECRET = 'test-mail-agent-secret';
const H = 'mail.journeys.on-grow.com';

const lines = (rp: string) => [
  `2026-11-17T19:23:02+00:00 ${H} postfix/qmgr[1]: 55B2C3EAF1: from=<${rp}>, size=12270, nrcpt=1 (queue active)`,
  `2026-11-17T19:23:03+00:00 ${H} postfix/smtp[2]: 55B2C3EAF1: to=<d@example.com>, relay=mx.example.com[1.2.3.4]:25, delay=0.4, delays=0.1/0/0.2/0.1, dsn=2.0.0, status=sent (250 ok)`,
];

describeMaybe('POST /internal/mail-deliveries (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let prevSecret: string | undefined;

  const post = (body: unknown, auth = `Bearer ${SECRET}`) =>
    app.request('/internal/mail-deliveries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(body),
    });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM email_events WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM messages_log WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM profiles WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id=$1', [WS]);
  }

  beforeAll(async () => {
    prevSecret = process.env.MAIL_AGENT_SECRET;
    process.env.MAIL_AGENT_SECRET = SECRET;
    pool = adminPool();
    app = createApp({ pool });
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await pool.query("INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,'d@example.com')", [PROFILE, WS]);
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

  it('rejects a wrong bearer and a malformed body', async () => {
    expect((await post({ lines: [] }, 'Bearer nope')).status).toBe(401);
    expect((await post({ lines: 'x' })).status).toBe(400);
  });

  it('records one delivery at the logged time, and a replay adds nothing', async () => {
    const rp = verpReturnPath('bounce.journeys.on-grow.com', unsubscribeLinkSecret(), MSG);
    const res = await post({ lines: lines(rp) });
    expect(await res.json()).toEqual({ ok: true, delivered: 1, ignored: 0 });
    await post({ lines: lines(rp) });

    const { rows } = await pool.query(
      'SELECT type, profile_id, occurred_at, raw FROM email_events WHERE workspace_id=$1',
      [WS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'delivery', profile_id: PROFILE });
    expect(new Date(rows[0].occurred_at).toISOString()).toBe('2026-11-17T19:23:03.000Z');
    expect(rows[0].raw).toMatchObject({ source: 'self-hosted-mta', dsn: '2.0.0' });
  });

  it('ignores a forged token', async () => {
    const rp = verpReturnPath('bounce.journeys.on-grow.com', 'not-our-secret', MSG);
    expect(await (await post({ lines: lines(rp) })).json()).toEqual({ ok: true, delivered: 0, ignored: 1 });
  });
});
