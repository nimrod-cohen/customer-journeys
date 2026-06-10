import { describe, it, expect } from 'vitest';
import { shouldMarkPermanentSoftBounce, PERMANENT_SOFT_BOUNCE_DAYS } from '../src/core.js';

// §10 "Soft bounce → permanent after N distinct DAYS (no delivery in between)".
// shouldMarkPermanentSoftBounce takes the count of distinct UTC days the address
// has soft-bounced on (INCLUDING today) and returns whether it's now permanent.

describe('shouldMarkPermanentSoftBounce(distinctDays, days)', () => {
  it('exposes a sane default threshold (3 days)', () => {
    expect(PERMANENT_SOFT_BOUNCE_DAYS).toBe(3);
  });

  it('does not flip before reaching N distinct days', () => {
    expect(shouldMarkPermanentSoftBounce(1, 3)).toBe(false);
    expect(shouldMarkPermanentSoftBounce(2, 3)).toBe(false);
  });

  it('flips on the Nth distinct day', () => {
    expect(shouldMarkPermanentSoftBounce(3, 3)).toBe(true);
  });

  it('stays permanent beyond N', () => {
    expect(shouldMarkPermanentSoftBounce(5, 3)).toBe(true);
  });

  it('uses the default N when not provided', () => {
    expect(shouldMarkPermanentSoftBounce(PERMANENT_SOFT_BOUNCE_DAYS)).toBe(true);
    expect(shouldMarkPermanentSoftBounce(PERMANENT_SOFT_BOUNCE_DAYS - 1)).toBe(false);
  });
});
