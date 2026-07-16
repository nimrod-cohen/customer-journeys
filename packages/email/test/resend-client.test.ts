// The Resend email transport: POSTs the SAME rendered SendEmailInput the SES path
// uses to Resend's API, with the connector's trusted From + the API key; returns
// Resend's id; throws on a non-2xx. HTTP is injected — no network.
import { describe, it, expect } from 'vitest';
import { createResendEmailClient, type ResendHttpClient } from '../src/index.js';

function fakeHttp(status: number, respBody: string): { client: ResendHttpClient; calls: { url: string; headers: Record<string, string>; body: string }[] } {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  return {
    calls,
    client: {
      async post(url, headers, reqBody) {
        calls.push({ url, headers, body: reqBody });
        return { status, body: respBody };
      },
    },
  };
}

const input = {
  from: 'ignored@input',
  to: 'jane@acme.com',
  subject: 'Hello Jane',
  html: '<p>Hi</p>',
  headers: { 'List-Unsubscribe': '<https://u>' },
};

describe('createResendEmailClient', () => {
  it('POSTs to Resend with the connector From + API key, returns the id', async () => {
    const http = fakeHttp(200, JSON.stringify({ id: 'resend-abc123' }));
    const client = createResendEmailClient({ apiKey: 're_key', from: 'Acme <news@acme.com>' }, http.client);
    const res = await client.sendEmail(input);
    expect(res.sesMessageId).toBe('resend-abc123');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(http.calls[0]!.headers.Authorization).toBe('Bearer re_key');
    const sent = JSON.parse(http.calls[0]!.body) as { from: string; to: string; subject: string; html: string; headers: Record<string, string> };
    expect(sent.from).toBe('Acme <news@acme.com>'); // connector From (input.from ignored)
    expect(sent.to).toBe('jane@acme.com');
    expect(sent.subject).toBe('Hello Jane');
    expect(sent.html).toBe('<p>Hi</p>');
    expect(sent.headers['List-Unsubscribe']).toBe('<https://u>'); // headers passed through
  });

  it('throws on a non-2xx response', async () => {
    const http = fakeHttp(422, JSON.stringify({ message: 'domain not verified' }));
    const client = createResendEmailClient({ apiKey: 're_key', from: 'a@b.com' }, http.client);
    await expect(client.sendEmail(input)).rejects.toThrow(/Resend send failed \(HTTP 422\)/);
  });

  it('the SES-specific identity methods are unsupported (Resend verifies its own domains)', () => {
    const client = createResendEmailClient({ apiKey: 'k', from: 'a@b.com' });
    expect(() => client.createDomainIdentity('x.com')).toThrow(/not supported/);
  });
});
