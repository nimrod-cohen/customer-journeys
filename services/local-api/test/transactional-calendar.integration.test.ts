// POST /v1/send with a meeting invite, end to end through the real Hono app.
//
// The pure rules live in transactional-calendar.test.ts. What this proves is the
// wiring: the ICS reaches the transport as a CALENDAR rather than a file, it is built
// per recipient (its own attendee, its own merge values), the organizer defaults to
// the message's From so clients trust it, a bcc never appears in the guest list, and
// a text key refuses instead of silently dropping the meeting.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { createApp, makeLocalDeps, makePgLookups } from '../src/index.js';
import { WORKSPACE_CHILD_TABLES } from '../src/handlers.js';
import { createHash } from 'node:crypto';
import type { SendEmailInput, SendEmailResult } from '@cdp/email';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// This file's OWN uuid prefix — the integration tier shares one database and each
// file cleans up by id, so a shared id means another file's teardown deletes these
// fixtures mid-run.
const CO = '0c0dd055-0000-4000-8000-000000000c01';
const WS = '0c0dd055-0000-4000-8000-000000000a01';
const DOMAIN = '0c0dd055-0000-4000-8000-0000000000d1';
const SENDER = '0c0dd055-0000-4000-8000-0000000000f1';
const TPL = '0c0dd055-0000-4000-8000-0000000000e1';
const TEXT_TPL = '0c0dd055-0000-4000-8000-0000000000e2';
const KEY = 'sk_live_0c0dd055calendar';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const INVITE = { title: 'Intro call', start: '2026-10-12T13:00:00Z', duration_minutes: 30 };

describeMaybe('POST /v1/send calendar invites (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  const sent: SendEmailInput[] = [];

  const send = (body: unknown) =>
    app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
  const ics = (i = 0) => sent[i]!.calendar!.ics;

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
              return { sesMessageId: 'cal-capture' };
            },
          },
        },
      },
    });
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Calendars')", [CO]);
    await pool.query("INSERT INTO workspaces (id, company_id, name, status) VALUES ($1,$2,'W','active')", [WS, CO]);
    await pool.query(
      "INSERT INTO ingest_keys (workspace_id, key_hash, key_prefix, key_full, label, kind) VALUES ($1,$2,'sk_live',NULL,'t','secret')",
      [WS, sha(KEY)],
    );
    await pool.query("INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ($1,$2,'acme.com',true)", [
      DOMAIN,
      WS,
    ]);
    await pool.query(
      "INSERT INTO domain_senders (id, workspace_id, domain, name, email) VALUES ($1,$2,'acme.com','Acme Bookings','bookings@acme.com')",
      [SENDER, WS],
    );
    await pool.query(
      `INSERT INTO email_templates (id, workspace_id, name, kind, mjml, subject, sender_id, to_address, compiled_html, transactional_key)
       VALUES ($1,$2,'Booking','library','<mjml/>','Your call with {{data.advisor}}',$3,'{{customer.email}}','<p>See you then.</p>','booking')`,
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

  it('sends the invite as a CALENDAR, not an attachment', async () => {
    sent.length = 0;
    const res = await send({ template: 'booking', to: 'jane@example.com', data: { advisor: 'Dana' }, calendar: INVITE });
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(true);

    expect(sent).toHaveLength(1);
    // The distinction that decides whether a client offers Accept / Decline.
    expect(sent[0]!.calendar?.method).toBe('REQUEST');
    expect(sent[0]!.attachments).toBeUndefined();
    expect(ics()).toContain('BEGIN:VEVENT');
    expect(ics()).toContain('DTSTART:20261012T130000Z');
    expect(ics()).toContain('DTEND:20261012T133000Z'); // duration_minutes applied
    expect(ics()).toContain('SUMMARY:Intro call');
  });

  // Gmail and Outlook only offer RSVP when the organizer matches the sending address.
  it('defaults the organizer to the message’s own From', async () => {
    expect(ics()).toContain('ORGANIZER;CN=Acme Bookings:mailto:bookings@acme.com');
  });

  it('names the recipient as the attendee who is asked to reply', async () => {
    expect(ics().split('\r\n ').join('')).toContain('ATTENDEE');
    expect(ics().split('\r\n ').join('')).toContain('mailto:jane@example.com');
    expect(ics()).toMatch(/RSVP=TRUE/);
  });

  it('falls back to the rendered subject when no title is given', async () => {
    sent.length = 0;
    await send({
      template: 'booking',
      to: 'jane@example.com',
      data: { advisor: 'Dana' },
      calendar: { start: INVITE.start, duration_minutes: 15 },
    });
    expect(ics()).toContain('SUMMARY:Your call with Dana');
  });

  it('renders merge tags in the invite’s own fields', async () => {
    sent.length = 0;
    await send({
      template: 'booking',
      to: 'jane@example.com',
      data: { advisor: 'Dana', room: 'Zoom' },
      calendar: { ...INVITE, title: 'Call with {{data.advisor}}', location: '{{data.room}}' },
    });
    expect(ics()).toContain('SUMMARY:Call with Dana');
    expect(ics()).toContain('LOCATION:Zoom');
  });

  // A list fans out: each person gets their OWN invite naming them, not a copy of
  // someone else's.
  it('builds a separate invite per recipient on a fan-out', async () => {
    sent.length = 0;
    const res = await send({
      template: 'booking',
      to: ['a@example.com', 'b@example.com'],
      data: { advisor: 'Dana' },
      calendar: INVITE,
    });
    expect((await res.json()).sent).toBe(2);
    expect(sent).toHaveLength(2);
    const flat = (i: number) => ics(i).split('\r\n ').join('');
    expect(flat(0)).toContain('mailto:a@example.com');
    expect(flat(0)).not.toContain('b@example.com');
    expect(flat(1)).toContain('mailto:b@example.com');
  });

  // An ATTENDEE line is printed in the guest list every invitee can read. A blind
  // copy listed there is no longer blind.
  it('lists a cc as an attendee and NEVER a bcc', async () => {
    sent.length = 0;
    await send({
      template: 'booking',
      to: 'jane@example.com',
      cc: ['colleague@example.com'],
      bcc: ['archive@example.com'],
      data: { advisor: 'Dana' },
      calendar: INVITE,
    });
    const flat = ics().split('\r\n ').join('');
    expect(flat).toContain('mailto:colleague@example.com');
    expect(flat).not.toContain('archive@example.com');
  });

  it('cancels with the original uid, marking the event CANCELLED', async () => {
    sent.length = 0;
    const res = await send({
      template: 'booking',
      to: 'jane@example.com',
      data: { advisor: 'Dana' },
      calendar: { ...INVITE, method: 'cancel', uid: 'booking-42', sequence: 1 },
    });
    expect(res.status).toBe(200);
    expect(sent[0]!.calendar?.method).toBe('CANCEL');
    expect(ics()).toContain('METHOD:CANCEL');
    expect(ics()).toContain('STATUS:CANCELLED');
    expect(ics()).toContain('UID:booking-42');
    expect(ics()).toContain('SEQUENCE:1');
  });

  it('400s a bad invite before any send', async () => {
    sent.length = 0;
    const res = await send({
      template: 'booking',
      to: 'jane@example.com',
      calendar: { title: 'x', start: '2026-10-12T13:00:00' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/timezone/i);
    expect(sent).toHaveLength(0);
  });

  // The key alone decides the medium, so a caller can address a text message without
  // meaning to. Dropping the meeting silently would look like a send that worked.
  it('400s an invite addressed to an SMS template', async () => {
    const res = await send({ template: 'otp-sms', to: '+972541111111', data: { code: '1' }, calendar: INVITE });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invite can only be emailed/i);
  });

  // Consent decides first — an invite does not buy its way past a suppression.
  it('still skips a suppressed recipient', async () => {
    sent.length = 0;
    await pool.query(
      "INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,'gone@example.com','hard_bounce','mta')",
      [WS],
    );
    const res = await send({ template: 'booking', to: 'gone@example.com', calendar: INVITE });
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('leaves an ordinary send with no calendar at all', async () => {
    sent.length = 0;
    await send({ template: 'booking', to: 'plain@example.com', data: { advisor: 'Dana' } });
    expect(sent[0]!.calendar).toBeUndefined();
  });
});
