import { describe, it, expect } from 'vitest';
import { createSmtpEmailClient, buildMimeMessage, type SmtpEnvelope } from '../src/smtp-client.js';
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
    const [head, body] = raw.split('\r\n\r\n');
    expect(head).toContain('Subject: Hello');
    expect(body).toBe('<p>hi</p>');
  });
});
