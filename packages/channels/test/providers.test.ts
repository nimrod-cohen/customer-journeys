import { describe, it, expect } from 'vitest';
import {
  MockSmsProvider,
  MockWhatsAppProvider,
  resolveChannelProvider,
  isMedium,
  isTextMedium,
  mediumLabel,
  MEDIUMS,
  type ChannelMessage,
} from '../src/index.js';

const msg = (over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  to: '+15551234567',
  body: 'Hi {{customer.first_name}}',
  ...over,
});

describe('mock channel providers (deterministic, never network)', () => {
  it('MockSmsProvider returns a mock-sms-<hash> id', async () => {
    const p = new MockSmsProvider();
    expect(p.medium).toBe('sms');
    const r = await p.send(msg());
    expect(r.providerMessageId).toMatch(/^mock-sms-[0-9a-f]{16}$/);
  });

  it('MockWhatsAppProvider returns a mock-wa-<hash> id', async () => {
    const p = new MockWhatsAppProvider();
    expect(p.medium).toBe('whatsapp');
    const r = await p.send(msg());
    expect(r.providerMessageId).toMatch(/^mock-wa-[0-9a-f]{16}$/);
  });

  it('is DETERMINISTIC: identical message → identical id', async () => {
    const a = await new MockSmsProvider().send(msg());
    const b = await new MockSmsProvider().send(msg());
    expect(a.providerMessageId).toBe(b.providerMessageId);
  });

  it('different (to) or (body) → different id', async () => {
    const base = await new MockSmsProvider().send(msg());
    const otherTo = await new MockSmsProvider().send(msg({ to: '+15559999999' }));
    const otherBody = await new MockSmsProvider().send(msg({ body: 'Different' }));
    expect(otherTo.providerMessageId).not.toBe(base.providerMessageId);
    expect(otherBody.providerMessageId).not.toBe(base.providerMessageId);
  });

  it('sms and whatsapp ids never collide for the same message', async () => {
    const sms = await new MockSmsProvider().send(msg());
    const wa = await new MockWhatsAppProvider().send(msg());
    expect(sms.providerMessageId).not.toBe(wa.providerMessageId);
  });
});

describe('resolveChannelProvider seam', () => {
  it('returns a MockSmsProvider for sms', () => {
    expect(resolveChannelProvider('sms')).toBeInstanceOf(MockSmsProvider);
  });
  it('returns a MockWhatsAppProvider for whatsapp', () => {
    expect(resolveChannelProvider('whatsapp')).toBeInstanceOf(MockWhatsAppProvider);
  });
  it('throws for email (it has the SES pipeline, not a channel here)', () => {
    expect(() => resolveChannelProvider('email')).toThrow(/not a text channel/);
  });
  it('throws for an unknown medium', () => {
    expect(() => resolveChannelProvider('carrier-pigeon' as never)).toThrow();
  });
  it('the resolved mock providers stay deterministic + offline', async () => {
    const p = resolveChannelProvider('sms');
    const r1 = await p.send(msg());
    const r2 = await p.send(msg());
    expect(r1.providerMessageId).toBe(r2.providerMessageId);
    expect(r1.providerMessageId).toMatch(/^mock-sms-/);
  });
});

describe('medium helpers', () => {
  it('isMedium recognises the three mediums and rejects others', () => {
    expect(MEDIUMS).toEqual(['email', 'sms', 'whatsapp']);
    for (const m of MEDIUMS) expect(isMedium(m)).toBe(true);
    expect(isMedium('fax')).toBe(false);
    expect(isMedium(undefined)).toBe(false);
  });
  it('isTextMedium is true only for sms/whatsapp', () => {
    expect(isTextMedium('sms')).toBe(true);
    expect(isTextMedium('whatsapp')).toBe(true);
    expect(isTextMedium('email')).toBe(false);
  });
  it('mediumLabel maps to a human label', () => {
    expect(mediumLabel('email')).toBe('Email');
    expect(mediumLabel('sms')).toBe('SMS');
    expect(mediumLabel('whatsapp')).toBe('WhatsApp');
  });
});

describe('Sms019Provider (real 019 gateway, injected HTTP — never network)', () => {
  // A fake client that records the request and returns a scripted response.
  function fakeClient(responses: Array<{ status: number; body: string } | Error>) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    let i = 0;
    const client = {
      async post(url: string, headers: Record<string, string>, body: string) {
        calls.push({ url, headers, body });
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        if (r instanceof Error) throw r;
        return r;
      },
    };
    return { client, calls };
  }
  const cfg = { apiUrl: 'https://019.example/sms', username: 'acme', source: 'Acme', bearer: 'tok-123' };

  it('builds the exact 019 request and maps status===0 to success', async () => {
    const { client, calls } = fakeClient([{ status: 200, body: JSON.stringify({ status: 0, message_id: 'm-1' }) }]);
    const { Sms019Provider } = await import('../src/index.js');
    const p = new Sms019Provider(cfg, client);
    const r = await p.send({ to: '+972500000000', body: 'hello' });
    expect(r.providerMessageId).toBe('m-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(cfg.apiUrl);
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok-123');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.body)).toEqual({
      sms: {
        user: { username: 'acme' },
        source: 'Acme',
        destinations: { phone: '+972500000000' },
        message: 'hello',
        add_dynamic: '0',
        add_unsubscribe: '0',
        response: '0',
        includes_international: '0',
      },
    });
  });

  it('throws on a non-zero status (no retry) and on a 4xx', async () => {
    const { Sms019Provider } = await import('../src/index.js');
    const nonZero = fakeClient([{ status: 200, body: JSON.stringify({ status: 999, message: 'bad' }) }]);
    await expect(new Sms019Provider(cfg, nonZero.client).send({ to: '+1', body: 'x' })).rejects.toThrow(/019 SMS: send rejected/);
    expect(nonZero.calls).toHaveLength(1);

    const four = fakeClient([{ status: 401, body: 'unauthorized' }]);
    await expect(new Sms019Provider(cfg, four.client).send({ to: '+1', body: 'x' })).rejects.toThrow(/HTTP 401/);
    expect(four.calls).toHaveLength(1); // 4xx → NOT retried
  });

  it('retries once on a 5xx then succeeds', async () => {
    const { Sms019Provider } = await import('../src/index.js');
    const { client, calls } = fakeClient([
      { status: 503, body: 'busy' },
      { status: 200, body: JSON.stringify({ status: 0, unique_id: 'u-9' }) },
    ]);
    const r = await new Sms019Provider(cfg, client).send({ to: '+1', body: 'x' });
    expect(r.providerMessageId).toBe('u-9');
    expect(calls).toHaveLength(2);
  });

  it('resolveChannelProvider returns the 019 adapter for sms+019 config, mock otherwise', async () => {
    const { Sms019Provider, MockSmsProvider, MockWhatsAppProvider } = await import('../src/index.js');
    const fake = { async post() { return { status: 200, body: '{"status":0}' }; } };
    expect(resolveChannelProvider('sms', { kind: '019', ...cfg }, fake)).toBeInstanceOf(Sms019Provider);
    expect(resolveChannelProvider('sms', { kind: 'mock' })).toBeInstanceOf(MockSmsProvider);
    // 019 is SMS-only — WhatsApp stays mock even if a config is passed.
    expect(resolveChannelProvider('whatsapp', { kind: 'mock' })).toBeInstanceOf(MockWhatsAppProvider);
  });
});
