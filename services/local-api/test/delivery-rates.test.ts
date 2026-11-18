import { describe, it, expect } from 'vitest';
import { deliveryRates } from '../src/delivery-rates.js';

describe('deliveryRates', () => {
  it('SES: every send draws a report, so rates match the classic formula', () => {
    const r = deliveryRates({ sent: 10, delivered: 8, bounced: 2, complained: 1 });
    expect(r.bounce).toBeCloseTo(0.2, 5);
    expect(r.complaint).toBeCloseTo(1 / 8, 5);
  });

  it('self-hosted SMTP: no delivery reports, so one bounce in 45 sends is ~2%, not 100%', () => {
    const r = deliveryRates({ sent: 45, delivered: 0, bounced: 1, complained: 0 });
    expect(r.bounce).toBeCloseTo(1 / 45, 5);
    expect(r.complaint).toBe(0);
  });

  it('self-hosted SMTP: complaints count against mail that was not bounced', () => {
    const r = deliveryRates({ sent: 100, delivered: 0, bounced: 4, complained: 2 });
    expect(r.complaint).toBeCloseTo(2 / 96, 5);
  });

  it('nothing sent → 0, never NaN', () => {
    expect(deliveryRates({ sent: 0, delivered: 0, bounced: 0, complained: 0 })).toEqual({ bounce: 0, complaint: 0 });
  });
});
