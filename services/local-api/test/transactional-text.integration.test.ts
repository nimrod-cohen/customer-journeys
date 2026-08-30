// POST /v1/send for SMS / WhatsApp — the text sibling of the email path.
//
// What matters here beyond the email case: one key namespace covers both media
// (so the integrator never says which one 'otp' is), the recipient is a phone,
// and the only consent gate is the channel opt-out — text has no bounce.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { createApp } from '../src/index.js';
import { WORKSPACE_CHILD_TABLES } from '../src/handlers.js';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const CO = '0c0d9911-0000-4000-8000-000000000c01';
const WS = '0c0d9911-0000-4000-8000-000000000a01';
const SMS_T = '0c0d9911-0000-4000-8000-0000000000e1';
const WA_T = '0c0d9911-0000-4000-8000-0000000000e2';
const KEY = 'sk_live_0c0d9911text';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describeMaybe('POST /v1/send — SMS/WhatsApp (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  const send = (body: unknown) =>
    app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });

  async function cleanup(): Promise<void> {
    for (const t of WORKSPACE_CHILD_TABLES) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [WS]).catch(() => {});
    }
    await pool.query('DELETE FROM ingest_keys WHERE workspace_id = $1', [WS]).catch(() => {});
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]).catch(() => {});
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]).catch(() => {});
  }

  beforeAll(async () => {
    pool = adminPool();
    app = createApp({ pool });
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Txt')", [CO]);
    await pool.query(
      "INSERT INTO workspaces (id, company_id, name, status, settings) VALUES ($1,$2,'W','active','{\"default_phone_country\":\"IL\"}'::jsonb)",
      [WS, CO],
    );
    await pool.query(
      "INSERT INTO ingest_keys (workspace_id, key_hash, key_prefix, label, kind) VALUES ($1,$2,'sk_live','t','secret')",
      [WS, sha(KEY)],
    );
    await pool.query(
      `INSERT INTO text_templates (id, workspace_id, name, body, transactional_key, transactional_medium) VALUES
         ($1,$3,'OTP SMS','Your code is {{data.code}}','otp-sms','sms'),
         ($2,$3,'Receipt','Thanks {{customer.first_name}}','receipt-wa','whatsapp')`,
      [SMS_T, WA_T, WS],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  it('sends an SMS, rendering data.* into the body', async () => {
    const res = await send({ template: 'otp-sms', to: '+972541111111', data: { code: '123456' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(true);
    expect(body.medium).toBe('sms');

    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages_log m JOIN profiles p ON p.id = m.profile_id
        WHERE m.workspace_id = $1 AND m.medium = 'sms' AND p.phone = '+972541111111'`,
      [WS],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('routes to WhatsApp when that is the template medium', async () => {
    const res = await send({ template: 'receipt-wa', to: '+972542222222' });
    expect((await res.json()).medium).toBe('whatsapp');
  });

  // A national number only resolves against the workspace's default country.
  it('normalizes a national number to E.164', async () => {
    const res = await send({ template: 'otp-sms', to: '054-3333333', data: { code: '1' } });
    expect((await res.json()).sent).toBe(true);
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1 AND phone = '+972543333333'",
      [WS],
    );
    expect(rows[0]!.n).toBe(1);
  });

  // A bad number is the caller's mistake to fix, not a decision about a person.
  it('400s an unparseable phone number', async () => {
    const res = await send({ template: 'otp-sms', to: 'not-a-phone' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/phone/);
  });

  it('does NOT send to someone who opted out of SMS/WhatsApp, unless told to', async () => {
    const p = await pool.query<{ id: string }>(
      "INSERT INTO profiles (workspace_id, phone) VALUES ($1,'+972544444444') RETURNING id",
      [WS],
    );
    await pool.query(
      "INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'sms_whatsapp')",
      [WS, p.rows[0]!.id],
    );

    const blocked = await send({ template: 'otp-sms', to: '+972544444444', data: { code: '1' } });
    expect(blocked.status).toBe(200);
    const b = await blocked.json();
    expect(b.sent).toBe(false);
    expect(b.reason).toMatch(/ignore_unsubscribe/);

    const forced = await send({
      template: 'otp-sms',
      to: '+972544444444',
      data: { code: '1' },
      ignore_unsubscribe: true,
    });
    expect((await forced.json()).sent).toBe(true);
  });

  // An email opt-out says nothing about whether someone wants a text.
  it('an email suppression does not block a text', async () => {
    const p = await pool.query<{ id: string }>(
      "INSERT INTO profiles (workspace_id, email, phone) VALUES ($1,'both@example.com','+972545555555') RETURNING id",
      [WS],
    );
    expect(p.rows[0]).toBeTruthy();
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'both@example.com','unsubscribe','test')",
      [WS],
    );
    const res = await send({ template: 'otp-sms', to: '+972545555555', data: { code: '1' } });
    expect((await res.json()).sent).toBe(true);
  });

  it('404s an unknown key', async () => {
    expect((await send({ template: 'nope', to: '+972541111111' })).status).toBe(404);
  });
});
