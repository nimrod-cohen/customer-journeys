// Cc and Bcc across all three transports.
//
// A copy is not a second send: one message, rendered once for the primary
// recipient, delivered to several addresses. Each transport expresses that
// differently, and getting it wrong is either a silent non-delivery (the copy
// never arrives) or a privacy failure (a bcc becomes visible), so all three are
// asserted against the same input.
import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ProdSesEmailClient, type SendEmailInput } from '../src/ses-client.js';
import { createResendEmailClient, type ResendHttpClient } from '../src/resend-client.js';
import { createSmtpEmailClient, buildMimeMessage, type SmtpEnvelope } from '../src/smtp-client.js';

const MSG = '11111111-2222-4333-8444-555555555555';
const input = (over: Partial<SendEmailInput> = {}): SendEmailInput => ({
  from: 'Acme <hello@acme.com>',
  to: 'jane@example.com',
  subject: 'Your receipt',
  html: '<p>Thanks!</p>',
  messageId: MSG,
  cc: ['accounts@acme.com'],
  bcc: ['archive@acme.com'],
  ...over,
});

describe('SES transport', () => {
  const ses = mockClient(SESv2Client);
  beforeEach(() => ses.reset());

  it('puts copies in the Destination, not in the body', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-1' });
    await new ProdSesEmailClient(ses as unknown as SESv2Client).sendEmail(input());
    const sent = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(sent.Destination?.ToAddresses).toEqual(['jane@example.com']);
    expect(sent.Destination?.CcAddresses).toEqual(['accounts@acme.com']);
    expect(sent.Destination?.BccAddresses).toEqual(['archive@acme.com']);
  });

  it('omits both fields when there are no copies', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-2' });
    await new ProdSesEmailClient(ses as unknown as SESv2Client).sendEmail(input({ cc: [], bcc: [] }));
    const sent = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(sent.Destination?.CcAddresses).toBeUndefined();
    expect(sent.Destination?.BccAddresses).toBeUndefined();
  });
});

describe('Resend transport', () => {
  function fakeHttp(): { client: ResendHttpClient; bodies: string[] } {
    const bodies: string[] = [];
    return {
      bodies,
      client: {
        async post(_u, _h, body) {
          bodies.push(body);
          return { status: 200, body: JSON.stringify({ id: 'r-1' }) };
        },
      },
    };
  }

  it('sends cc and bcc as their own fields', async () => {
    const http = fakeHttp();
    await createResendEmailClient({ apiKey: 'k', from: 'Acme <a@acme.com>' }, http.client).sendEmail(input());
    const sent = JSON.parse(http.bodies[0]!) as { cc: string[]; bcc: string[] };
    expect(sent.cc).toEqual(['accounts@acme.com']);
    expect(sent.bcc).toEqual(['archive@acme.com']);
  });

  it('sends neither key when there are no copies', async () => {
    const http = fakeHttp();
    await createResendEmailClient({ apiKey: 'k', from: 'a@b.com' }, http.client).sendEmail(
      input({ cc: undefined, bcc: undefined }),
    );
    const sent = JSON.parse(http.bodies[0]!);
    expect(sent).not.toHaveProperty('cc');
    expect(sent).not.toHaveProperty('bcc');
  });
});

describe('self-hosted SMTP transport', () => {
  function fakeTransport(): { sent: SmtpEnvelope[]; transport: { send(e: SmtpEnvelope): Promise<void> } } {
    const sent: SmtpEnvelope[] = [];
    return { sent, transport: { async send(e) { sent.push(e); } } };
  }
  const cfg = { host: 'mail.x', port: 587, bounceDomain: 'bounce.x', verpSecret: 's' };

  // The envelope decides delivery. A bcc that appears in no header and no envelope
  // is simply never delivered — a copy silently lost.
  it('delivers to every address through the envelope', async () => {
    const { sent, transport } = fakeTransport();
    await createSmtpEmailClient(cfg, transport).sendEmail(input());
    expect(sent[0]!.recipients).toEqual(['jane@example.com', 'accounts@acme.com', 'archive@acme.com']);
  });

  it('shows Cc in the headers and NEVER Bcc — that is what blind means', async () => {
    const { sent, transport } = fakeTransport();
    await createSmtpEmailClient(cfg, transport).sendEmail(input());
    const head = sent[0]!.raw.split('\r\n\r\n')[0]!;
    expect(head).toContain('Cc: accounts@acme.com');
    expect(head.toLowerCase()).not.toContain('bcc');
    expect(sent[0]!.raw).not.toContain('archive@acme.com'); // nowhere in the message
  });

  it('adds no Cc header when there are no copies', () => {
    const raw = buildMimeMessage(input({ cc: [], bcc: [] }), MSG, 'acme.com');
    expect(raw).not.toContain('Cc:');
  });

  // An address is caller-supplied and lands in a header, so a CRLF in it must not
  // be able to append one of its own.
  it('cannot inject a header through a cc address', () => {
    const raw = buildMimeMessage(
      input({ cc: ['ok@acme.com\r\nBcc: attacker@evil.com'], bcc: [] }),
      MSG,
      'acme.com',
    );
    expect(raw.split('\r\n').some((l) => /^Bcc:/i.test(l))).toBe(false);
  });
});
