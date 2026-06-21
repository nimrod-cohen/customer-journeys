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
