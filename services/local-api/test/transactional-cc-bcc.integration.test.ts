// Cc / Bcc on POST /v1/send, end to end through the real Hono app.
//
// The pure rules live in transactional-attachments.test.ts. What this file proves
// is the behaviour that makes a copy a COPY rather than a second send:
//
//   - one message, rendered once for the primary, delivered to several addresses;
//   - a cc'd accountant does not become a profile in the CDP;
//   - consent gates the primary, deliverability gates everyone;
//   - a bcc is never echoed anywhere it could leak.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { createApp, makeLocalDeps, makePgLookups } from '../src/index.js';
import { WORKSPACE_CHILD_TABLES } from '../src/handlers.js';
import { MAX_RECIPIENTS } from '../src/transactional-send.js';
import { createHash } from 'node:crypto';
import type { SendEmailInput, SendEmailResult } from '@cdp/email';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const CO = '0c0dc033-0000-4000-8000-000000000c01';
const WS = '0c0dc033-0000-4000-8000-000000000a01';
const DOMAIN = '0c0dc033-0000-4000-8000-0000000000d1';
const SENDER = '0c0dc033-0000-4000-8000-0000000000f1';
const TPL = '0c0dc033-0000-4000-8000-0000000000e1';
const TEXT_TPL = '0c0dc033-0000-4000-8000-0000000000e2';
const KEY = 'sk_live_0c0dc033copies';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describeMaybe('POST /v1/send cc/bcc (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
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
              return { sesMessageId: 'capture' };
            },
          },
        },
      },
    });
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Copies')", [CO]);
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
       VALUES ($1,$2,'Receipt','library','<mjml/>','Receipt for {{customer.email}}',$3,'{{customer.email}}',
               '<p>Hi {{customer.first_name}}</p>','receipt')`,
      [TPL, WS, SENDER],
    );
    await pool.query(
      `INSERT INTO text_templates (id, workspace_id, name, body, transactional_key, transactional_medium)
       VALUES ($1,$2,'Code','Your code','otp-sms','sms')`,
      [TEXT_TPL, WS],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it('delivers one message to the primary plus its copies, and counts them back', async () => {
    const res = await send({
      template: 'receipt',
      to: 'jane@example.com',
      cc: 'accounts@acme.com',
      bcc: ['archive@acme.com'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, recipients: { to: 1, cc: 1, bcc: 1 } });

    expect(sent).toHaveLength(1); // ONE message, not three sends
    expect(sent[0]!.to).toBe('jane@example.com');
    expect(sent[0]!.cc).toEqual(['accounts@acme.com']);
    expect(sent[0]!.bcc).toEqual(['archive@acme.com']);
  });

  // Copies are addresses, not people. Creating profiles for them would fill the CDP
  // with accountants and archive mailboxes, sweep them into segments and count them
  // as customers.
  it('creates a profile for the primary only', async () => {
    await send({ template: 'receipt', to: 'primary@example.com', cc: ['cc-only@acme.com'], bcc: ['bcc-only@acme.com'] });
    const { rows } = await pool.query<{ email: string }>(
      "SELECT email::text AS email FROM profiles WHERE workspace_id = $1 AND email IN ('cc-only@acme.com','bcc-only@acme.com','primary@example.com')",
      [WS],
    );
    expect(rows.map((r) => r.email)).toEqual(['primary@example.com']);
  });

  // The copies are recorded ON the message so a later bounce naming one can be
  // attributed to it rather than to the primary.
  it('records the copies on the message row', async () => {
    const res = await send({ template: 'receipt', to: 'logged@example.com', cc: ['seen@acme.com'], bcc: ['blind@acme.com'] });
    const id = (await res.json()).message_id;
    const { rows } = await pool.query<{ cc_addresses: string[]; bcc_addresses: string[] }>(
      'SELECT cc_addresses, bcc_addresses FROM messages_log WHERE workspace_id = $1 AND ses_message_id = $2',
      [WS, id],
    );
    expect(rows[0]!.cc_addresses).toEqual(['seen@acme.com']);
    expect(rows[0]!.bcc_addresses).toEqual(['blind@acme.com']);
  });

  // A stale archive address must never cost the primary their receipt.
  it('drops a hard-bounced copy, still sends, and names the dropped cc', async () => {
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'dead@acme.com','hard_bounce','mta')",
      [WS],
    );
    const res = await send({
      template: 'receipt',
      to: 'fine@example.com',
      cc: ['dead@acme.com', 'alive@acme.com'],
    });
    const body = await res.json();
    expect(body.sent).toBe(true);
    expect(body.recipients.cc).toBe(1);
    expect(body.dropped.cc).toEqual(['dead@acme.com']);
    expect(sent[0]!.cc).toEqual(['alive@acme.com']);
  });

  // A dropped BCC is counted, never listed — nothing may echo a blind copy.
  it('reports a dropped bcc as a count only', async () => {
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'deadbcc@acme.com','complaint','fbl')",
      [WS],
    );
    const res = await send({ template: 'receipt', to: 'fine2@example.com', bcc: ['deadbcc@acme.com'] });
    const body = await res.json();
    expect(body.dropped.bcc).toBe(1);
    expect(JSON.stringify(body)).not.toContain('deadbcc@acme.com');
  });

  // A cc'd person never subscribed to anything, so an unsubscribe from marketing
  // says nothing about whether they should get an invoice copy.
  it('does NOT drop a copy to someone who merely unsubscribed', async () => {
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'unsub@acme.com','unsubscribe','pref-centre')",
      [WS],
    );
    const res = await send({ template: 'receipt', to: 'fine3@example.com', cc: ['unsub@acme.com'] });
    expect((await res.json()).recipients.cc).toBe(1);
    expect(sent[0]!.cc).toEqual(['unsub@acme.com']);
  });

  // Consent still gates the PRIMARY, and a skipped primary sends nothing at all —
  // a copy is not a way around someone's unsubscribe.
  it('skips the whole message when the primary is suppressed', async () => {
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'gone@example.com','unsubscribe','pref-centre')",
      [WS],
    );
    const res = await send({ template: 'receipt', to: 'gone@example.com', cc: ['watcher@acme.com'] });
    expect((await res.json()).sent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // One message carries ONE signed unsubscribe token, belonging to the primary. A
  // cc'd reader hitting their mail client's one-click Unsubscribe button would
  // therefore unsubscribe the PRIMARY — silently, unconfirmed, wrong person.
  // Transactional mail carries no List-Unsubscribe header at all, which is what
  // makes that impossible; this locks it in.
  it('puts no one-click unsubscribe header on a message with copies', async () => {
    await send({ template: 'receipt', to: 'primary2@example.com', cc: ['copy@acme.com'] });
    const headers = sent[0]!.headers ?? {};
    const names = Object.keys(headers).map((h) => h.toLowerCase());
    expect(names).not.toContain('list-unsubscribe');
    expect(names).not.toContain('list-unsubscribe-post');
  });

  it('400s an address that could inject a header', async () => {
    const res = await send({ template: 'receipt', to: 'x@example.com', cc: ['ok@acme.com\r\nBcc: attacker@evil.com'] });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('400s more recipients than the cap', async () => {
    const res = await send({
      template: 'receipt',
      to: 'x@example.com',
      cc: Array.from({ length: MAX_RECIPIENTS }, (_, i) => `c${i}@acme.com`),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(new RegExp(`${MAX_RECIPIENTS}`));
  });

  it('400s cc on an SMS key rather than dropping it silently', async () => {
    const res = await send({ template: 'otp-sms', to: '+972541111111', cc: ['x@acme.com'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cc or bcc/i);
  });

  // SES bills per recipient, so a message with copies costs more than one send.
  it('meters recipients, not messages', async () => {
    await pool.query("DELETE FROM usage_counters WHERE workspace_id = $1 AND metric = 'email_recipients'", [WS]);
    await send({ template: 'receipt', to: 'metered@example.com', cc: ['a@acme.com'], bcc: ['b@acme.com'] });
    const { rows } = await pool.query<{ value: string }>(
      "SELECT value FROM usage_counters WHERE workspace_id = $1 AND metric = 'email_recipients'",
      [WS],
    );
    expect(Number(rows[0]!.value)).toBe(3);
  });
});
