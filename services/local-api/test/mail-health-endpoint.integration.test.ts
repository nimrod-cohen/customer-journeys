// POST /internal/mail-health and the data behind GET /admin/mail-health, on REAL
// Postgres through the real app.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import type { Pool } from 'pg';
import { createApp } from '../src/index.js';
import { HETZNER_IP, LINODE_IP, loadMailHealth } from '../src/mail-health.js';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;
const SECRET = 'test-mail-agent-secret';
const WS = '0c0d0f33-0000-4000-8000-000000000a01';
const PROFILE = '0c0d0f33-0000-4000-8000-0000000000c1';
const EMAIL = 'health-person@hotmail.com';

const report = (ip: string, code: number, reply: string) => ({
  ip,
  checked_at: new Date().toISOString(),
  relayhost: ip === HETZNER_IP ? '[relay1.journeys.on-grow.com]:587' : '',
  smtp: [
    { provider: 'google', mx: 'g', stage: 'mail', code: 250, reply: '250 OK' },
    { provider: 'microsoft', mx: 'm', stage: 'mail', code, reply },
    { provider: 'apple', mx: 'a', stage: 'mail', code: 250, reply: '250 OK' },
  ],
  dnsbl: [],
});

describeMaybe('mail health (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let prevSecret: string | undefined;

  const post = (body: unknown, auth = `Bearer ${SECRET}`) =>
    app.request('/internal/mail-health', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(body),
    });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM mail_health_reports WHERE ip = ANY($1)', [[HETZNER_IP, LINODE_IP]]);
    await pool.query('DELETE FROM email_events WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM profiles WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id=$1', [WS]);
  }

  beforeAll(async () => {
    prevSecret = process.env.MAIL_AGENT_SECRET;
    process.env.MAIL_AGENT_SECRET = SECRET;
    pool = adminPool();
    await cleanup();
    await pool.query(`INSERT INTO workspaces (id, name, status) VALUES ($1, 'Health WS', 'active')`, [WS]);
    await pool.query(`INSERT INTO profiles (id, workspace_id, email) VALUES ($1, $2, $3)`, [PROFILE, WS, EMAIL]);
    app = createApp({ pool });
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    if (prevSecret === undefined) delete process.env.MAIL_AGENT_SECRET;
    else process.env.MAIL_AGENT_SECRET = prevSecret;
  });

  it('refuses a caller without the agent secret and stores nothing', async () => {
    const r = await post(report(LINODE_IP, 250, '250 OK'), 'Bearer wrong');
    expect(r.status).toBe(401);
    const { rows } = await pool.query('SELECT 1 FROM mail_health_reports WHERE ip=$1', [LINODE_IP]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a report for an IP that is not ours', async () => {
    expect((await post(report('203.0.113.9', 250, '250 OK'))).status).toBe(400);
  });

  it('stores reports and shows the newest as a block', async () => {
    expect((await post(report(HETZNER_IP, 250, '250 OK'))).status).toBe(200);
    expect((await post(report(LINODE_IP, 550, '550 5.7.1 on our block list (S3150)'))).status).toBe(200);
    const h = await loadMailHealth(pool, new Date());
    const ms = h.servers.find((s) => s.ip === LINODE_IP)!.providers.find((p) => p.provider === 'microsoft')!;
    expect(ms).toMatchObject({ status: 'blocked', block_code: 'S3150' });
    expect(h.delivering_ip).toBe(LINODE_IP);
  });

  it('counts real rejections by provider without exposing the address', async () => {
    await pool.query(
      `INSERT INTO email_events (workspace_id, ses_message_id, profile_id, type, sub_type, raw, occurred_at)
       VALUES ($1, 'health-msg-1', $2, 'bounce', '5.7.1', $3::jsonb, now())`,
      [WS, PROFILE, JSON.stringify({ recipient: EMAIL, diagnostic: `550 5.7.1 <${EMAIL}> refused (S3150)` })],
    );
    const h = await loadMailHealth(pool, new Date());
    const row = h.rejections.find((r) => r.provider === 'microsoft')!;
    expect(row.count).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(h)).not.toContain(EMAIL);
  });
});
