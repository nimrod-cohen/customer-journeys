// Attachments cross ALL THREE email transports. One `SendEmailInput.attachments`
// list, three very different wire formats — SES takes decoded bytes through the
// SDK, Resend takes base64 in JSON, and the self-hosted SMTP path has to build the
// multipart MIME itself. A file that arrives on one provider and silently vanishes
// on another is the failure this file exists to prevent, so every transport is
// asserted against the SAME input.
import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ProdSesEmailClient } from '../src/ses-client.js';
import { createResendEmailClient, type ResendHttpClient } from '../src/resend-client.js';
import { createSmtpEmailClient, buildMimeMessage, type SmtpEnvelope } from '../src/smtp-client.js';
import type { SendEmailInput } from '../src/ses-client.js';

const MSG = '11111111-2222-4333-8444-555555555555';
const PDF = Buffer.from('%PDF-1.4 fake invoice').toString('base64');

const input = (over: Partial<SendEmailInput> = {}): SendEmailInput => ({
  from: 'Acme <hello@acme.com>',
  to: 'jane@example.com',
  subject: 'Your receipt',
  html: '<p>Thanks!</p>',
  messageId: MSG,
  attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: PDF }],
  ...over,
});

describe('SES transport', () => {
  const ses = mockClient(SESv2Client);
  beforeEach(() => ses.reset());

  it('sends the attachment as decoded bytes on the Simple content', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-1' });
    await new ProdSesEmailClient(ses as unknown as SESv2Client).sendEmail(input());

    const sent = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    const atts = sent.Content?.Simple?.Attachments ?? [];
    expect(atts).toHaveLength(1);
    expect(atts[0]!.FileName).toBe('invoice.pdf');
    expect(atts[0]!.ContentType).toBe('application/pdf');
    expect(atts[0]!.ContentDisposition).toBe('ATTACHMENT');
    // The SDK base64-encodes for us, so it must receive BYTES — handing it the
    // base64 string would attach a text file full of base64.
    expect(Buffer.from(atts[0]!.RawContent!).toString('utf8')).toBe('%PDF-1.4 fake invoice');
  });

  it('omits the Attachments field entirely when there are none', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-2' });
    await new ProdSesEmailClient(ses as unknown as SESv2Client).sendEmail(input({ attachments: [] }));
    const sent = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(sent.Content?.Simple?.Attachments).toBeUndefined();
  });
});

describe('Resend transport', () => {
  function fakeHttp(): { client: ResendHttpClient; bodies: string[] } {
    const bodies: string[] = [];
    return {
      bodies,
      client: {
        async post(_url, _headers, body) {
          bodies.push(body);
          return { status: 200, body: JSON.stringify({ id: 'resend-1' }) };
        },
      },
    };
  }

  it('POSTs the attachment as base64 in the JSON body', async () => {
    const http = fakeHttp();
    await createResendEmailClient({ apiKey: 're_k', from: 'Acme <a@acme.com>' }, http.client).sendEmail(input());
    const sent = JSON.parse(http.bodies[0]!) as {
      attachments: Array<{ filename: string; content: string; content_type: string }>;
    };
    expect(sent.attachments).toEqual([
      { filename: 'invoice.pdf', content: PDF, content_type: 'application/pdf' },
    ]);
  });

  it('sends no attachments key when there are none', async () => {
    const http = fakeHttp();
    await createResendEmailClient({ apiKey: 're_k', from: 'a@b.com' }, http.client).sendEmail(
      input({ attachments: undefined }),
    );
    expect(JSON.parse(http.bodies[0]!)).not.toHaveProperty('attachments');
  });
});

describe('self-hosted SMTP transport', () => {
  function fakeTransport(): { sent: SmtpEnvelope[]; transport: { send(e: SmtpEnvelope): Promise<void> } } {
    const sent: SmtpEnvelope[] = [];
    return { sent, transport: { async send(e) { sent.push(e); } } };
  }

  // Without attachments the message stays a plain text/html body — adding a
  // multipart wrapper to every message would change mail that has no attachment.
  it('leaves an attachment-free message single-part', () => {
    const raw = buildMimeMessage(input({ attachments: [] }), MSG, 'acme.com');
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
    expect(raw).not.toContain('multipart/mixed');
  });

  it('wraps body + file in multipart/mixed with a base64 part', async () => {
    const { sent, transport } = fakeTransport();
    await createSmtpEmailClient(
      { host: 'mail.x', port: 587, bounceDomain: 'bounce.x', verpSecret: 's' },
      transport,
    ).sendEmail(input());
    const raw = sent[0]!.raw;

    const boundary = /Content-Type: multipart\/mixed; boundary="([^"]+)"/.exec(raw)?.[1];
    expect(boundary).toBeTruthy();
    expect(raw).toContain('<p>Thanks!</p>');
    expect(raw).toContain('Content-Type: application/pdf; name="invoice.pdf"');
    expect(raw).toContain('Content-Disposition: attachment; filename="invoice.pdf"');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    expect(raw).toContain(PDF);
    expect(raw.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  // RFC 2045 caps an encoded line at 76 characters; some MTAs reject longer ones
  // and others silently wrap mid-stream, corrupting the file.
  it('wraps base64 at 76 characters', async () => {
    const { sent, transport } = fakeTransport();
    const big = Buffer.alloc(1000, 7).toString('base64');
    await createSmtpEmailClient(
      { host: 'mail.x', port: 587, bounceDomain: 'bounce.x', verpSecret: 's' },
      transport,
    ).sendEmail(input({ attachments: [{ filename: 'blob.bin', contentType: 'application/octet-stream', content: big }] }));
    const encoded = sent[0]!.raw.split('\r\n').filter((l) => /^[A-Za-z0-9+/]+={0,2}$/.test(l) && l.length > 20);
    expect(encoded.length).toBeGreaterThan(1); // it really did wrap
    for (const line of encoded) expect(line.length).toBeLessThanOrEqual(76);
  });

  // A filename is caller-supplied and lands inside a quoted header parameter, so a
  // quote or a CRLF in it would end the parameter early and let the rest be read as
  // headers of its own.
  it('cannot inject headers through the filename', () => {
    const raw = buildMimeMessage(
      input({
        attachments: [
          { filename: 'a".pdf\r\nBcc: attacker@evil.com', contentType: 'application/pdf', content: PDF },
        ],
      }),
      MSG,
      'acme.com',
    );
    // The name stays inside its quoted parameter: what matters is that nothing in
    // it can START a line, which is the only way it becomes a header.
    expect(raw.split('\r\n').some((l) => /^Bcc:/i.test(l))).toBe(false);
    expect(raw).toMatch(/filename="[^"\r\n]*"/);
  });

  // Same for the content type, which is not quoted at all.
  it('falls back to a safe content type when given a malformed one', () => {
    const raw = buildMimeMessage(
      input({ attachments: [{ filename: 'x.pdf', contentType: 'text/html\r\nBcc: a@b.c', content: PDF }] }),
      MSG,
      'acme.com',
    );
    expect(raw).not.toContain('Bcc: a@b.c');
    expect(raw).toContain('Content-Type: application/octet-stream; name="x.pdf"');
  });
});
