import { describe, it, expect } from 'vitest';
import { createSmtpEmailClient, buildMimeMessage, type SmtpEnvelope } from '../src/smtp-client.js';
import { buildIcs } from '../src/icalendar.js';
import { parseVerpRecipient, unpackVerpToken } from '../src/verp.js';
import type { SendEmailInput } from '../src/ses-client.js';

const MSG = '11111111-2222-4333-8444-555555555555';
const CFG = {
  host: 'mail.journeys.on-grow.com',
  port: 587,
  bounceDomain: 'bounce.journeys.on-grow.com',
  verpSecret: 'verp-secret',
};

function fakeTransport() {
  const sent: SmtpEnvelope[] = [];
  return {
    sent,
    transport: {
      async send(e: SmtpEnvelope) {
        sent.push(e);
      },
    },
  };
}

const input = (over: Partial<SendEmailInput> = {}): SendEmailInput =>
  ({
    from: 'Acme <hello@acme.com>',
    to: 'person@example.com',
    subject: 'Hello',
    html: '<p>hi</p>',
    messageId: MSG,
    ...over,
  }) as SendEmailInput;

describe('createSmtpEmailClient', () => {
  it('sends with a VERP envelope sender that resolves back to the message', async () => {
    const { sent, transport } = fakeTransport();
    const res = await createSmtpEmailClient(CFG, transport).sendEmail(input());

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('person@example.com');
    expect(sent[0]!.returnPath).toMatch(/^bounce\+.+@bounce\.journeys\.on-grow\.com$/);
    expect(unpackVerpToken(CFG.verpSecret, parseVerpRecipient(sent[0]!.returnPath))).toBe(MSG);
    expect(res.sesMessageId).toBe(MSG);
  });

  // The recipient must never see the bounce address — only the company's own From:.
  it('keeps the visible From header separate from the envelope sender', async () => {
    const { sent, transport } = fakeTransport();
    await createSmtpEmailClient(CFG, transport).sendEmail(input());
    expect(sent[0]!.raw).toContain('From: Acme <hello@acme.com>');
    expect(sent[0]!.raw).not.toContain('bounce+');
  });

  it('refuses to send without a message id, since the bounce could not be attributed', async () => {
    const { transport } = fakeTransport();
    await expect(
      createSmtpEmailClient(CFG, transport).sendEmail(input({ messageId: undefined })),
    ).rejects.toThrow(/messageId/i);
  });

  it('throws for SES-only identity operations', () => {
    const { transport } = fakeTransport();
    const c = createSmtpEmailClient(CFG, transport);
    expect(() => c.createDomainIdentity('x.com')).toThrow(/not supported/i);
    expect(() => c.createConfigurationSet('x')).toThrow(/not supported/i);
  });
});

describe('buildMimeMessage', () => {
  it('sets a Message-ID aligned with the sending domain', () => {
    const raw = buildMimeMessage(input(), MSG, 'acme.com');
    expect(raw).toContain(`Message-ID: <${MSG}@acme.com>`);
  });

  it('passes through extra headers such as List-Unsubscribe', () => {
    const raw = buildMimeMessage(
      input({ headers: { 'List-Unsubscribe': '<https://x/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }),
      MSG,
      'acme.com',
    );
    expect(raw).toContain('List-Unsubscribe: <https://x/u>');
    expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  // Subject and To are merge-rendered per recipient, so a value carrying CRLF
  // could otherwise append arbitrary headers.
  it('strips CRLF from header values to prevent header injection', () => {
    const raw = buildMimeMessage(
      input({ subject: 'Hi\r\nBcc: attacker@evil.com', to: 'a@b.com\r\nBcc: x@evil.com' }),
      MSG,
      'acme.com',
    );
    // The payload survives as inert TEXT inside the Subject value; what must not
    // happen is it becoming a header line of its own.
    expect(raw).not.toMatch(/^Bcc:/im);
    const head = raw.split('\r\n\r\n')[0]!;
    expect(head).toContain('Subject: Hi Bcc: attacker@evil.com');
    expect(head).toContain('To: a@b.com Bcc: x@evil.com');
    expect(head.split('\r\n').filter((l) => /^Subject:/i.test(l))).toHaveLength(1);
    expect(head.split('\r\n').filter((l) => /^To:/i.test(l))).toHaveLength(1);
  });

  it('does not let a caller-supplied header overwrite a controlled one', () => {
    const raw = buildMimeMessage(input({ headers: { From: 'spoof@evil.com', 'Message-ID': '<x@evil>' } }), MSG, 'acme.com');
    const head = raw.split('\r\n\r\n')[0]!;
    expect(head).toContain('From: Acme <hello@acme.com>');
    expect(head).not.toContain('spoof@evil.com');
    expect(head.match(/^Message-ID:/gim)).toHaveLength(1);
  });

  it('separates headers from body with a blank line', () => {
    const raw = buildMimeMessage(input(), MSG, 'acme.com');
    const [head, ...rest] = raw.split('\r\n\r\n');
    expect(head).toContain('Subject: Hello');
    // The body travels base64-encoded (see smtp-client `encodedTextPart`).
    expect(rest.join('\r\n\r\n')).toContain(Buffer.from('<p>hi</p>', 'utf8').toString('base64'));
  });
});

// A meeting invite is NOT an attachment. The bytes a client offers "Accept /
// Decline" for live in a `text/calendar; method=…` part inside a
// multipart/alternative beside the HTML; the same bytes attached are a file to
// download. Every assertion here is about that structure, because a message that
// gets it wrong still arrives, still looks fine, and simply never becomes a meeting.
describe('buildMimeMessage with a calendar invite', () => {
  const ics = buildIcs(
    {
      summary: 'Intro call',
      start: new Date('2026-10-12T13:00:00.000Z'),
      end: new Date('2026-10-12T13:30:00.000Z'),
      organizer: { email: 'hello@acme.com', name: 'Acme' },
      attendees: [{ email: 'jane@example.com' }],
    },
    new Date('2026-10-08T09:00:00.000Z'),
  );
  const base = {
    from: 'Acme <hello@acme.com>',
    to: 'jane@example.com',
    subject: 'Invitation: Intro call',
    html: '<p>See you then.</p>',
  };
  const invite = { ics, method: 'REQUEST' as const };

  it('puts the calendar in a multipart/alternative, not an attachment', () => {
    const mime = buildMimeMessage({ ...base, calendar: invite }, 'm-1', 'mail.example.com');
    expect(mime).toMatch(/^Content-Type: multipart\/alternative; boundary="[^"]+"/m);
    expect(mime).not.toMatch(/multipart\/mixed/);
    // Content-Disposition: attachment is exactly what turns an invite into a file.
    expect(mime).not.toMatch(/Content-Disposition: attachment/);
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8');
  });

  // Gmail shows the event but NO Accept/Decline without method= on the part itself.
  it('carries method= on the calendar part’s own Content-Type', () => {
    const mime = buildMimeMessage({ ...base, calendar: invite }, 'm-1', 'mail.example.com');
    expect(mime).toMatch(/Content-Type: text\/calendar; charset=UTF-8; method=REQUEST/);
    expect(buildMimeMessage({ ...base, calendar: { ics, method: 'CANCEL' } }, 'm-1', 'x.com')).toMatch(/method=CANCEL/);
  });

  // In a multipart/alternative the LAST part is the one a client prefers. HTML last
  // is what makes Outlook render the mail and ignore the invite.
  it('orders the calendar part after the HTML', () => {
    const mime = buildMimeMessage({ ...base, calendar: invite }, 'm-1', 'mail.example.com');
    expect(mime.indexOf('text/html')).toBeLessThan(mime.indexOf('text/calendar'));
  });

  it('base64-encodes the ics, decoding back to the exact calendar', () => {
    const mime = buildMimeMessage({ ...base, calendar: invite }, 'm-1', 'mail.example.com');
    const part = mime.slice(mime.indexOf('text/calendar'));
    const b64 = part.slice(part.indexOf('\r\n\r\n') + 4).split(/\r\n--/)[0]!;
    expect(Buffer.from(b64.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(ics);
  });

  it('closes every boundary it opens', () => {
    const mime = buildMimeMessage({ ...base, calendar: invite }, 'm-1', 'mail.example.com');
    const boundary = /boundary="([^"]+)"/.exec(mime)![1]!;
    expect(mime.split(`--${boundary}`).length - 1).toBe(4); // text + html + calendar + the closer
    expect(mime).toContain(`--${boundary}--`);
  });

  // An invite that also carries a file needs BOTH containers: the alternative holds
  // the body and the invite, and sits as one part inside the mixed container.
  it('nests the alternative inside multipart/mixed when a file rides along', () => {
    const mime = buildMimeMessage(
      {
        ...base,
        calendar: invite,
        attachments: [{ filename: 'agenda.pdf', contentType: 'application/pdf', content: 'JVBERi0=' }],
      },
      'm-2',
      'mail.example.com',
    );
    const mixed = /Content-Type: multipart\/mixed; boundary="([^"]+)"/.exec(mime)![1]!;
    const alt = /Content-Type: multipart\/alternative; boundary="([^"]+)"/.exec(mime)![1]!;
    expect(alt).not.toBe(mixed); // distinct boundaries, or the parser ends both at once
    expect(mime.indexOf(`--${mixed}`)).toBeLessThan(mime.indexOf(`--${alt}`));
    expect(mime).toContain(`--${alt}--`);
    expect(mime).toContain(`--${mixed}--`);
    expect(mime).toMatch(/Content-Disposition: attachment; filename="agenda.pdf"/);
    expect(mime).toMatch(/method=REQUEST/);
  });

  // Ordinary mail carries no calendar part — but it IS still multipart/alternative,
  // because every message now has a plain-text alternative.
  it('leaves a message with no invite free of any calendar part', () => {
    const mime = buildMimeMessage(base, 'm-3', 'mail.example.com');
    expect(mime).toMatch(/Content-Type: text\/html; charset=UTF-8/);
    expect(mime).toMatch(/Content-Type: text\/plain; charset=UTF-8/);
    expect(mime).not.toMatch(/text\/calendar/);
  });
});
