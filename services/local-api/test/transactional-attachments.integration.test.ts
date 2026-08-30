// POST /v1/send with attachments, end to end through the real Hono app.
//
// The pure rules live in transactional-attachments.test.ts; what this file proves
// is the wiring: the files actually reach the transport, an oversize or malformed
// batch is refused BEFORE any provider call, a text key says so instead of quietly
// dropping them, and the consent gates still decide first — a suppressed recipient
// costs nothing even with 20 MB attached.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { createApp, makeLocalDeps, makePgLookups } from '../src/index.js';
import { WORKSPACE_CHILD_TABLES } from '../src/handlers.js';
import { MAX_ATTACHMENTS } from '../src/transactional-send.js';
import { createHash } from 'node:crypto';
import type { SendEmailInput, SendEmailResult } from '@cdp/email';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const CO = '0c0d7788-0000-4000-8000-000000000c01';
const WS = '0c0d7788-0000-4000-8000-000000000a01';
const DOMAIN = '0c0d7788-0000-4000-8000-0000000000d1';
const SENDER = '0c0d7788-0000-4000-8000-0000000000f1';
const TPL = '0c0d7788-0000-4000-8000-0000000000e1';
const TEXT_TPL = '0c0d7788-0000-4000-8000-0000000000e2';
const KEY = 'sk_live_0c0d7788attach';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const PDF = Buffer.from('%PDF-1.4 the august report').toString('base64');

describeMaybe('POST /v1/send attachments (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  // Every send the app makes, captured at the transport boundary — the only place
  // that can prove a file survived the whole path.
  const sent: SendEmailInput[] = [];

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
    const deps = makeLocalDeps(pool);
    app = createApp({
      pool,
      lookups: makePgLookups(pool),
      deps: {
        ...deps,
        onboarding: {
          ...deps.onboarding,
          ses: {
            ...deps.onboarding.ses,
            async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
              sent.push(input);
              return { sesMessageId: 'capture-1' };
            },
          },
        },
      },
    });
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Attach')", [CO]);
    await pool.query("INSERT INTO workspaces (id, company_id, name, status) VALUES ($1,$2,'W','active')", [WS, CO]);
    await pool.query(
      "INSERT INTO ingest_keys (workspace_id, key_hash, key_prefix, key_full, label, kind) VALUES ($1,$2,'sk_live',NULL,'t','secret')",
      [WS, sha(KEY)],
    );
    await pool.query("INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'acme.com',true)", [DOMAIN, WS]);
    await pool.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'acme.com','Acme','hello@acme.com')",
      [SENDER, WS],
    );
    await pool.query(
      `INSERT INTO email_templates (id, workspace_id, name, kind, mjml, subject, sender_id, to_address, compiled_html, transactional_key)
       VALUES ($1,$2,'Report','library','<mjml/>','Your {{data.month}} report',$3,'{{customer.email}}','<p>Attached.</p>','report')`,
      [TPL, WS, SENDER],
    );
    await pool.query(
      `INSERT INTO text_templates (id, workspace_id, name, body, transactional_key, transactional_medium)
       VALUES ($1,$2,'Code','Your code is {{data.code}}','otp-sms','sms')`,
      [TEXT_TPL, WS],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  it('delivers the file to the transport, and reports how many it sent', async () => {
    sent.length = 0;
    const res = await send({
      template: 'report',
      to: 'investor@example.com',
      data: { month: 'August' },
      attachments: [{ filename: 'August report.pdf', content_type: 'application/pdf', content: PDF }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sent: true, attachments: 1 });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Your August report'); // merge still works alongside
    expect(sent[0]!.attachments).toEqual([
      { filename: 'August report.pdf', contentType: 'application/pdf', content: PDF },
    ]);
  });

  // The bytes are worth money — egress on a report PDF times an investor list is
  // not noise, and the counter has to exist before it can ever be priced.
  it('meters the attached bytes against the workspace', async () => {
    const { rows } = await pool.query<{ value: string }>(
      "SELECT value FROM usage_counters WHERE workspace_id = $1 AND metric = 'attachment_bytes'",
      [WS],
    );
    expect(Number(rows[0]?.value ?? 0)).toBe(Buffer.from(PDF, 'base64').length);
  });

  it('sends nothing at all when there are no attachments', async () => {
    sent.length = 0;
    const res = await send({ template: 'report', to: 'plain@example.com', data: { month: 'July' } });
    expect((await res.json()).attachments).toBeUndefined();
    expect(sent[0]!.attachments).toBeUndefined();
  });

  // Validation runs before the provider: an oversize batch must cost one 400, not
  // a 33 MB upload to SES that fails there.
  it('400s an oversize batch without calling the transport', async () => {
    sent.length = 0;
    const huge = 'A'.repeat(Math.ceil((26 * 1024 * 1024) / 3) * 4);
    const res = await send({
      template: 'report',
      to: 'investor@example.com',
      attachments: [{ filename: 'huge.pdf', content: huge }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/25 MB/);
    expect(sent).toHaveLength(0);
  });

  it('400s malformed base64, naming the file', async () => {
    const res = await send({
      template: 'report',
      to: 'investor@example.com',
      attachments: [{ filename: 'broken.pdf', content: 'this is not base64' }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/broken\.pdf.*base64/);
  });

  it('400s more files than the per-message limit', async () => {
    const res = await send({
      template: 'report',
      to: 'investor@example.com',
      attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ filename: `f${i}.pdf`, content: PDF })),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an executable rather than getting the domain blocklisted', async () => {
    const res = await send({
      template: 'report',
      to: 'investor@example.com',
      attachments: [{ filename: 'setup.exe', content: PDF }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.exe/);
  });

  // The key alone decides the medium, so a caller can reach a text message without
  // meaning to. Dropping the files silently would look like a send that worked.
  it('400s attachments addressed to an SMS template', async () => {
    const res = await send({
      template: 'otp-sms',
      to: '+972541111111',
      data: { code: '1' },
      attachments: [{ filename: 'x.pdf', content: PDF }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/SMS/i);
  });

  // Consent decides first: a suppressed recipient is still a 200 skip, and the
  // attachment never reaches a provider.
  it('still skips a suppressed recipient, attachments and all', async () => {
    sent.length = 0;
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'gone@example.com','hard_bounce','mta')",
      [WS],
    );
    const res = await send({
      template: 'report',
      to: 'gone@example.com',
      attachments: [{ filename: 'report.pdf', content: PDF }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
