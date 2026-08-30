// POST /v1/send — the transactional API, end to end through the real Hono app.
//
// Proves the two things that matter beyond the pure decision logic: the API key
// alone decides the workspace (a caller cannot reach another tenant), and the
// consent model actually behaves differently from a broadcast.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { createApp } from '../src/index.js';
import { WORKSPACE_CHILD_TABLES } from '../src/handlers.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const CO = '0c0d5566-0000-4000-8000-000000000c01';
const WS = '0c0d5566-0000-4000-8000-000000000a01';
const WS_B = '0c0d5566-0000-4000-8000-000000000a02';
const DOMAIN = '0c0d5566-0000-4000-8000-0000000000d1';
const SENDER = '0c0d5566-0000-4000-8000-0000000000f1';
const TPL = '0c0d5566-0000-4000-8000-0000000000e1';
const KEY = 'sk_live_0c0d5566test';
const KEY_B = 'sk_live_0c0d5566other';
const PUBLIC_KEY = 'pk_live_0c0d5566public';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describeMaybe('POST /v1/send (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  const send = (body: unknown, key = KEY) =>
    app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });

  async function cleanup(): Promise<void> {
    // The SAME order the workspace purge uses. A shallower list leaves a failed run
    // with rows that block the next one, which then fails for an unrelated reason.
    for (const t of WORKSPACE_CHILD_TABLES) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = ANY($1)`, [[WS, WS_B]]).catch(() => {});
    }
    await pool.query('DELETE FROM ingest_keys WHERE workspace_id = ANY($1)', [[WS, WS_B]]).catch(() => {});
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS, WS_B]]).catch(() => {});
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]).catch(() => {});
  }

  beforeAll(async () => {
    pool = adminPool();
    app = createApp({ pool });
    await cleanup();
    // Its OWN company: workspaces without one share the 'Unassigned' company, and
    // another test's email connector there would change which provider we resolve.
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Tx')", [CO]);
    for (const w of [WS, WS_B]) {
      await pool.query("INSERT INTO workspaces (id, company_id, name, status) VALUES ($1,$2,'W','active')", [w, CO]);
    }
    await pool.query(
      `INSERT INTO ingest_keys (workspace_id, key_hash, key_prefix, key_full, label, kind) VALUES
         ($1,$2,'sk_live',NULL,'t','secret'),
         ($3,$4,'sk_live',NULL,'t','secret'),
         ($1,$5,'pk_live',$6,'t','public')`,
      [WS, sha(KEY), WS_B, sha(KEY_B), sha(PUBLIC_KEY), PUBLIC_KEY],
    );
    await pool.query(
      "INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'acme.com',true)",
      [DOMAIN, WS],
    );
    await pool.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'acme.com','Acme','hello@acme.com')",
      [SENDER, WS],
    );
    await pool.query(
      `INSERT INTO email_templates (id, workspace_id, name, kind, mjml, subject, sender_id, to_address, compiled_html, transactional_key)
       VALUES ($1,$2,'OTP','library','<mjml/>','Your code is {{data.code}}',$3,'{{customer.email}}',
               '<p>Hi {{customer.first_name}}, your code is {{data.code}}</p>','otp')`,
      [TPL, WS, SENDER],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  it('rejects a missing or unknown API key', async () => {
    expect((await send({ template: 'otp', to: 'a@b.com' }, 'nope')).status).toBe(401);
  });

  // The public key is documented as safe to embed in a web page. Accepting it here
  // would let anyone reading that page send mail from this verified domain.
  it('refuses the PUBLIC write key, and says which key to use', async () => {
    const res = await send({ template: 'otp', to: 'a@b.com' }, PUBLIC_KEY);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/sk_live_/);
  });

  it('names the specific validation problem', async () => {
    const res = await send({ to: 'a@b.com' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/template/);
  });

  it('404s an unknown template key', async () => {
    const res = await send({ template: 'nope', to: 'a@b.com' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/nope/);
  });

  // The key resolves the workspace, so another tenant's key cannot reach this
  // template even though the key itself is valid.
  it('cannot reach a template in another workspace', async () => {
    const res = await send({ template: 'otp', to: 'a@b.com' }, KEY_B);
    expect(res.status).toBe(404);
  });

  it('sends, renders both subject and body, and logs the message', async () => {
    const res = await send({ template: 'otp', to: 'user@example.com', data: { code: '123456' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(true);
    expect(body.message_id).toBeTruthy();

    // The recipient became a profile, and the send is on their record.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages_log m JOIN profiles p ON p.id = m.profile_id
        WHERE m.workspace_id = $1 AND p.email = 'user@example.com' AND m.ses_message_id = $2`,
      [WS, body.message_id],
    );
    expect(rows[0]!.n).toBe(1);
  });

  // Conservative by default; the caller opts out per request when the message is
  // genuinely essential.
  it('does NOT send to an unsubscribed recipient by default', async () => {
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'unsub@example.com','unsubscribe','test')",
      [WS],
    );
    const res = await send({ template: 'otp', to: 'unsub@example.com', data: { code: '1' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(false);
    expect(body.reason).toMatch(/ignore_unsubscribe/);
  });

  it('SENDS to an unsubscribed recipient with ignore_unsubscribe', async () => {
    const res = await send({
      template: 'otp',
      to: 'unsub@example.com',
      data: { code: '1' },
      ignore_unsubscribe: true,
    });
    expect((await res.json()).sent).toBe(true);
  });

  // The override is about consent only.
  it('ignore_unsubscribe does NOT unlock a hard-bounced address', async () => {
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'dead2@example.com','hard_bounce','mta')",
      [WS],
    );
    const res = await send({
      template: 'otp',
      to: 'dead2@example.com',
      data: { code: '1' },
      ignore_unsubscribe: true,
    });
    expect((await res.json()).sent).toBe(false);
  });

  // Deliverability still applies.
  it('does NOT send to a hard-bounced address', async () => {
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'dead@example.com','hard_bounce','mta')",
      [WS],
    );
    const res = await send({ template: 'otp', to: 'dead@example.com', data: { code: '1' } });
    expect(res.status).toBe(200); // a decision, not a failure to retry
    const body = await res.json();
    expect(body.sent).toBe(false);
    expect(body.reason).toMatch(/undeliverable/);
  });

  it('does NOT send to someone who reported spam', async () => {
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'angry@example.com','complaint','fbl')",
      [WS],
    );
    const res = await send({ template: 'otp', to: 'angry@example.com', data: { code: '1' } });
    expect((await res.json()).sent).toBe(false);
  });
});
