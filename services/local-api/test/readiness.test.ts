// Pure unit tests for computeReadiness — the configuration-readiness logic that decides
// which channels are enabled and what still needs configuring.
import { describe, it, expect } from 'vitest';
import { computeReadiness, type ReadinessInputs } from '../src/readiness.js';

const BASE: ReadinessInputs = {
  hasResendConnector: false,
  resendFromSet: false,
  hasSesConnector: false,
  verifiedDomainCount: 0,
  senderCount: 0,
  hasSmsConnector: false,
  hasWhatsappConnector: false,
  r2Configured: false,
};

const check = (r: ReturnType<typeof computeReadiness>, id: string) => r.checks.find((c) => c.id === id)!;

describe('computeReadiness — email', () => {
  it('nothing configured → email not_configured, channel disabled', () => {
    const r = computeReadiness(BASE);
    expect(r.channels.email).toBe(false);
    expect(check(r, 'email').status).toBe('not_configured');
    expect(check(r, 'email').summary).toMatch(/Connect an email provider/i);
  });

  it('SES connector but no verified domain → incomplete, disabled', () => {
    const r = computeReadiness({ ...BASE, hasSesConnector: true });
    expect(r.channels.email).toBe(false);
    expect(check(r, 'email').status).toBe('incomplete');
    expect(check(r, 'email').summary).toMatch(/Verify a sending domain/i);
  });

  it('SES + verified domain but NO sender → incomplete, disabled (the user rule)', () => {
    const r = computeReadiness({ ...BASE, hasSesConnector: true, verifiedDomainCount: 1 });
    expect(r.channels.email).toBe(false);
    expect(check(r, 'email').summary).toMatch(/sender address/i);
    // the sender item is the failing one
    const senderItem = check(r, 'email').items.find((i) => /sender/i.test(i.label))!;
    expect(senderItem.ok).toBe(false);
  });

  it('SES + verified domain + sender → email READY, channel enabled', () => {
    const r = computeReadiness({ ...BASE, hasSesConnector: true, verifiedDomainCount: 2, senderCount: 1 });
    expect(r.channels.email).toBe(true);
    expect(check(r, 'email').status).toBe('ready');
    expect(check(r, 'email').items.every((i) => i.ok)).toBe(true);
  });

  it('a verified domain WITHOUT an email provider connector is NOT enough', () => {
    const r = computeReadiness({ ...BASE, verifiedDomainCount: 3, senderCount: 2 });
    expect(r.channels.email).toBe(false);
    expect(check(r, 'email').status).toBe('not_configured');
  });

  it('Resend connector with a From → ready without an in-app domain/sender', () => {
    const r = computeReadiness({ ...BASE, hasResendConnector: true, resendFromSet: true });
    expect(r.channels.email).toBe(true);
    expect(check(r, 'email').status).toBe('ready');
  });

  it('Resend connector WITHOUT a From → incomplete', () => {
    const r = computeReadiness({ ...BASE, hasResendConnector: true, resendFromSet: false });
    expect(r.channels.email).toBe(false);
    expect(check(r, 'email').summary).toMatch(/Resend/i);
  });
});

describe('computeReadiness — sms / whatsapp', () => {
  it('no connector → not_configured + disabled; connector → ready + enabled', () => {
    const off = computeReadiness(BASE);
    expect(off.channels.sms).toBe(false);
    expect(off.channels.whatsapp).toBe(false);
    expect(check(off, 'sms').status).toBe('not_configured');

    const on = computeReadiness({ ...BASE, hasSmsConnector: true, hasWhatsappConnector: true });
    expect(on.channels.sms).toBe(true);
    expect(on.channels.whatsapp).toBe(true);
    expect(check(on, 'sms').status).toBe('ready');
    expect(check(on, 'whatsapp').status).toBe('ready');
  });
});

describe('computeReadiness — storage (warning) + counts', () => {
  it('R2 missing is a WARNING, never disables anything, and not an error', () => {
    const r = computeReadiness({ ...BASE, hasSesConnector: true, verifiedDomainCount: 1, senderCount: 1, hasSmsConnector: true, hasWhatsappConnector: true });
    expect(check(r, 'storage').severity).toBe('warning');
    expect(check(r, 'storage').status).toBe('not_configured');
    expect(r.errorCount).toBe(0); // all channels ready → no errors
    expect(r.warningCount).toBe(1); // just the storage warning
  });

  it('errorCount counts each not-ready channel; R2 present clears the warning', () => {
    const r = computeReadiness({ ...BASE, r2Configured: true }); // no channels configured
    expect(r.errorCount).toBe(3); // email + sms + whatsapp
    expect(r.warningCount).toBe(0);
  });
});
