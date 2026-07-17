import { describe, it, expect } from 'vitest';
import {
  decideDispatch,
  resolveTextRecipient,
  buildChannelMessage,
  type DispatchContext,
} from '../src/index.js';

// Pure core: the medium-aware gate (text channels skip the verified-domain gate
// but still refuse a non-active workspace) + the text recipient/message builders.
const base = (over: Partial<DispatchContext> = {}): DispatchContext => ({
  workspace: { id: 'w', status: 'active', sending_identity: { verified: false } },
  profile: { id: 'p', email: 'p@example.com' },
  template: { compiledHtml: '' },
  subject: '',
  // phone is now a CORE reserved field → the canonical merge key is customer.phone
  // (customerMerge produces it from the column, falling back to attributes.phone).
  merge: { 'customer.phone': '+15550001111', 'customer.attributes.first_name': 'Jo' },
  frequencyCap: null,
  quietHours: null,
  timeZone: 'UTC',
  recentSendCount: 0,
  isSuppressed: false,
  now: new Date('2026-06-22T12:00:00Z'),
  unsubscribeBaseUrl: 'https://x/unsub',
  ...over,
});

describe('medium-aware gate', () => {
  it('EMAIL: an UNVERIFIED workspace is refused (the verified-domain gate)', () => {
    const d = decideDispatch(base({ medium: 'email' }));
    expect(d.action).toBe('refuse');
    expect(d.stoppedAt).toBe('gate');
  });

  it('SMS: an UNVERIFIED but ACTIVE workspace PASSES the gate (verified-domain is email-only)', () => {
    const d = decideDispatch(base({ medium: 'sms', textBody: 'hi', toAddress: '{{customer.phone}}' }));
    expect(d.action).toBe('send');
  });

  it('WhatsApp: a SUSPENDED workspace is still refused (active-only gate applies to all channels)', () => {
    const d = decideDispatch(
      base({ medium: 'whatsapp', workspace: { id: 'w', status: 'suspended', sending_identity: null } }),
    );
    expect(d.action).toBe('refuse');
    expect(d.stoppedAt).toBe('gate');
  });

  it('SMS: suppression still applies (after the gate)', () => {
    const d = decideDispatch(base({ medium: 'sms', isSuppressed: true }));
    expect(d.action).toBe('skip');
    expect(d.stoppedAt).toBe('suppression');
  });

  it('SMS: frequency cap still applies', () => {
    const d = decideDispatch(base({ medium: 'sms', frequencyCap: { max: 1, days: 7 }, recentSendCount: 1 }));
    expect(d.action).toBe('skip');
    expect(d.stoppedAt).toBe('frequency-cap');
  });
});

describe('resolveTextRecipient', () => {
  it('renders {{customer.phone}} to the recipient phone', () => {
    expect(resolveTextRecipient(base({ toAddress: '{{customer.phone}}' }))).toBe('+15550001111');
  });
  it('an UNRESOLVED token (no phone in merge) → empty (the recipient has no phone)', () => {
    expect(resolveTextRecipient(base({ toAddress: '{{customer.phone}}', merge: {} }))).toBe('');
  });
  it('falls back to ctx.phone when no toAddress', () => {
    expect(resolveTextRecipient(base({ toAddress: null, phone: '+15559998888', merge: {} }))).toBe('+15559998888');
  });
});

describe('buildChannelMessage', () => {
  it('renders the body merge tags + the phone To (no MJML/HTML)', () => {
    const m = buildChannelMessage(base({ medium: 'sms', toAddress: '{{customer.phone}}', textBody: 'Hi {{customer.first_name}}' }));
    expect(m).toEqual({ to: '+15550001111', body: 'Hi Jo' });
  });
  it('throws when the recipient has no phone', () => {
    expect(() => buildChannelMessage(base({ medium: 'sms', toAddress: '{{customer.phone}}', merge: {}, phone: null }))).toThrow(/no phone/);
  });
});
