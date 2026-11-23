import { describe, it, expect } from 'vitest';
import { describeDeliveryStatus } from '../src/delivery-status.js';
import { toActivityRow } from '../src/handlers.js';

describe('activity row for a bounce', () => {
  const row = (detail: string, diagnostic: string) =>
    toActivityRow({
      at: '2026-11-20T14:20:29Z',
      source: 'email',
      type: 'bounce',
      outcome: 'failure',
      profile_id: null,
      detail,
      ref_id: null,
      retryable: false,
      raw: { recipient: 'person@live.com', diagnostic },
      email: null,
      message_sent_at: null,
      message_status: null,
      message_subject: null,
      broadcast_id: null,
      broadcast_name: null,
      automation_id: null,
      automation_name: null,
    }).context?.failure;

  it('does not call a policy block permanent', () => {
    const f = row('5.7.1', 'smtp; 550 5.7.1 part of their network is on our block list (S3150)');
    expect(f?.permanent).toBe(false);
    expect(f?.meaning).toMatch(/not suppressed/);
  });
  it('still calls a missing mailbox permanent', () => {
    const f = row('5.1.1', 'smtp; 550 5.1.1 no such user');
    expect(f?.permanent).toBe(true);
    expect(f?.meaning).toMatch(/will not be emailed again/);
  });
});

describe('describeDeliveryStatus', () => {
  it('explains a policy refusal as permanent', () => {
    const d = describeDeliveryStatus('5.7.1');
    expect(d?.permanent).toBe(true);
    expect(d?.meaning).toMatch(/refused the message by policy/);
  });
  it('marks 4.x.x as transient', () => {
    expect(describeDeliveryStatus('4.2.2')).toMatchObject({ permanent: false, meaning: 'The mailbox is full.' });
  });
  it('falls back to the subject digit for an unlisted code', () => {
    expect(describeDeliveryStatus('5.1.99')?.meaning).toMatch(/recipient address/);
  });
  it('returns null for anything that is not a status code', () => {
    expect(describeDeliveryStatus('Permanent')).toBeNull();
    expect(describeDeliveryStatus(null)).toBeNull();
    expect(describeDeliveryStatus('')).toBeNull();
  });
});
