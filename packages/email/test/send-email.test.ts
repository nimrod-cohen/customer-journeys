import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ProdSesEmailClient, type SendEmailInput } from '../src/ses-client.js';

// §9 step 6 / §10 — the prod SES wrapper's sendEmail is unit-tested with
// aws-sdk-client-mock; SES is NEVER really called. Asserts the SendEmailCommand
// input maps from our SendEmailInput (From / Destination / ConfigurationSetName /
// Subject / HTML body / List-Unsubscribe headers) and returns the SES message id.
const ses = mockClient(SESv2Client);

function input(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    from: 'news@mail.acme.com',
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<html><body>Hi</body></html>',
    configurationSetName: 'ws-cfgset-123',
    headers: {
      'List-Unsubscribe': '<https://api.cdp.example/unsubscribe?workspace_id=w&email=e>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    ...overrides,
  };
}

describe('ProdSesEmailClient.sendEmail', () => {
  beforeEach(() => ses.reset());

  it('sends a SendEmailCommand and returns the ses message id', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-msg-abc' });
    const client = new ProdSesEmailClient(ses as unknown as SESv2Client);
    const res = await client.sendEmail(input());
    expect(res.sesMessageId).toBe('ses-msg-abc');

    const calls = ses.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const sent = calls[0]!.args[0].input;
    expect(sent.FromEmailAddress).toBe('news@mail.acme.com');
    expect(sent.Destination?.ToAddresses).toEqual(['recipient@example.com']);
    expect(sent.ConfigurationSetName).toBe('ws-cfgset-123');
    expect(sent.Content?.Simple?.Subject?.Data).toBe('Hello');
    expect(sent.Content?.Simple?.Body?.Html?.Data).toBe('<html><body>Hi</body></html>');
  });

  it('passes the List-Unsubscribe headers through as message Headers', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-msg-xyz' });
    const client = new ProdSesEmailClient(ses as unknown as SESv2Client);
    await client.sendEmail(input());

    const sent = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    const headers = sent.Content?.Simple?.Headers ?? [];
    const byName = Object.fromEntries(headers.map((h) => [h.Name, h.Value]));
    expect(byName['List-Unsubscribe']).toBe(
      '<https://api.cdp.example/unsubscribe?workspace_id=w&email=e>',
    );
    expect(byName['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('returns an empty string id when SES omits a MessageId', async () => {
    ses.on(SendEmailCommand).resolves({});
    const client = new ProdSesEmailClient(ses as unknown as SESv2Client);
    const res = await client.sendEmail(input());
    expect(res.sesMessageId).toBe('');
  });
});
