import { describe, it, expect } from 'vitest';
import {
  ResendMailer,
  MockTransactionalMailer,
  resolveTransactionalMailer,
  TxSendError,
  buildInviteEmail,
  buildPasswordResetEmail,
  type TxHttpClient,
} from '../src/index.js';

function fakeHttp(status: number, respBody: string): { http: TxHttpClient; calls: Array<{ url: string; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  return {
    calls,
    http: {
      async post(url, headers, reqBody) {
        calls.push({ url, headers, body: reqBody });
        return { status, body: respBody };
      },
    },
  };
}

describe('transactional mailer', () => {
  it('MockTransactionalMailer records sends deterministically (no network)', async () => {
    const m = new MockTransactionalMailer();
    const a = await m.send({ to: 'x@y.com', subject: 'Hi', html: '<b>hi</b>' });
    const b = await m.send({ to: 'x@y.com', subject: 'Hi', html: '<b>DIFFERENT</b>' });
    expect(m.sends).toHaveLength(2);
    expect(a.id).toMatch(/^mock-tx-/);
    expect(a.id).toBe(b.id); // id keys on to+subject, deterministic
  });

  it('ResendMailer POSTs the right shape and parses the id', async () => {
    const { http, calls } = fakeHttp(200, JSON.stringify({ id: 'resend-123' }));
    const m = new ResendMailer({ apiKey: 'sk_test', from: 'On-Grow <no-reply@notifications.on-grow.com>' }, http);
    const res = await m.send({ to: 'to@x.com', subject: 'Subject', html: '<p>body</p>', text: 'body' });
    expect(res.id).toBe('resend-123');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk_test');
    const payload = JSON.parse(calls[0]!.body) as { from: string; to: string[]; subject: string; html: string; text: string };
    expect(payload.from).toBe('On-Grow <no-reply@notifications.on-grow.com>');
    expect(payload.to).toEqual(['to@x.com']);
    expect(payload.subject).toBe('Subject');
    expect(payload.text).toBe('body');
  });

  it('ResendMailer throws TxSendError on a non-2xx response', async () => {
    const { http } = fakeHttp(422, '{"message":"bad from"}');
    const m = new ResendMailer({ apiKey: 'sk', from: 'x' }, http);
    await expect(m.send({ to: 't@x.com', subject: 's', html: 'h' })).rejects.toBeInstanceOf(TxSendError);
  });

  it('resolveTransactionalMailer → Resend with an apiKey, else the mock', () => {
    expect(resolveTransactionalMailer({ apiKey: 'sk', from: 'f' })).toBeInstanceOf(ResendMailer);
    expect(resolveTransactionalMailer({ apiKey: null, from: null })).toBeInstanceOf(MockTransactionalMailer);
    expect(resolveTransactionalMailer({ apiKey: '   ' })).toBeInstanceOf(MockTransactionalMailer);
  });

  it('system-email builders embed the link + a clear subject', () => {
    const invite = buildInviteEmail({ companyName: 'Acme', acceptUrl: 'https://app/#/accept-invite?token=T1', inviterName: 'Nim' });
    expect(invite.subject).toMatch(/Acme/);
    expect(invite.html).toContain('https://app/#/accept-invite?token=T1');
    expect(invite.text).toContain('https://app/#/accept-invite?token=T1');
    expect(invite.html).toContain('Nim'); // inviter name

    const reset = buildPasswordResetEmail({ resetUrl: 'https://app/#/reset-password?token=T2' });
    expect(reset.subject).toMatch(/reset/i);
    expect(reset.html).toContain('https://app/#/reset-password?token=T2');
  });
});
