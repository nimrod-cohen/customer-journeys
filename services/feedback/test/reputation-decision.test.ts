import { describe, it, expect } from 'vitest';
import {
  decideReputation,
  BOUNCE_RATE_CRITICAL,
  COMPLAINT_RATE_CRITICAL,
  MIN_SENT_FOR_RATE,
} from '../src/core.js';

// §10 reputation policing — auto-suspend the offending workspace when its
// per-workspace bounce or complaint rate breaches a critical threshold. A
// MIN_SENT_FOR_RATE guard avoids suspending on tiny denominators (one bounce
// out of two sends is not a signal).

describe('decideReputation({sent,bounces,complaints})', () => {
  it('exposes thresholds near the SES critical lines', () => {
    expect(BOUNCE_RATE_CRITICAL).toBeCloseTo(0.05, 3);
    expect(COMPLAINT_RATE_CRITICAL).toBeCloseTo(0.001, 4);
    expect(MIN_SENT_FOR_RATE).toBeGreaterThan(0);
  });

  it('does not suspend below the MIN_SENT_FOR_RATE guard, even at a high ratio', () => {
    const d = decideReputation({ sent: MIN_SENT_FOR_RATE - 1, bounces: MIN_SENT_FOR_RATE, complaints: 0 });
    expect(d.suspend).toBe(false);
    expect(d.reason).toMatch(/insufficient|min/i);
  });

  it('suspends when the bounce rate breaches the critical threshold', () => {
    const sent = MIN_SENT_FOR_RATE * 10;
    const bounces = Math.ceil(sent * (BOUNCE_RATE_CRITICAL + 0.01));
    const d = decideReputation({ sent, bounces, complaints: 0 });
    expect(d.suspend).toBe(true);
    expect(d.reason).toMatch(/bounce/i);
  });

  it('suspends when the complaint rate breaches the critical threshold', () => {
    const sent = MIN_SENT_FOR_RATE * 100;
    const complaints = Math.ceil(sent * (COMPLAINT_RATE_CRITICAL + 0.001));
    const d = decideReputation({ sent, bounces: 0, complaints });
    expect(d.suspend).toBe(true);
    expect(d.reason).toMatch(/complaint/i);
  });

  it('does not suspend a healthy workspace above the guard', () => {
    const sent = MIN_SENT_FOR_RATE * 100;
    const d = decideReputation({ sent, bounces: 1, complaints: 0 });
    expect(d.suspend).toBe(false);
  });

  it('exposes the computed rates', () => {
    const d = decideReputation({ sent: 1000, bounces: 10, complaints: 1 });
    expect(d.bounceRate).toBeCloseTo(0.01, 5);
    expect(d.complaintRate).toBeCloseTo(0.001, 5);
  });
});
