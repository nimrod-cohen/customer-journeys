import { describe, it, expect } from 'vitest';
import { describeDeliveryStatus } from '../src/delivery-status.js';

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
