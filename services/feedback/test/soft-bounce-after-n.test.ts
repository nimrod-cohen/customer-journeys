import { describe, it, expect } from 'vitest';
import { shouldSuppressSoftBounce, SOFT_BOUNCE_THRESHOLD_N } from '../src/core.js';

// §10 "Soft bounce → count; suppress after N". shouldSuppressSoftBounce takes
// the count of PRIOR distinct soft-bounce events (before the current one) and
// the threshold N, and returns whether the current soft bounce crosses it.

describe('shouldSuppressSoftBounce(priorCount, N)', () => {
  it('exposes a sane default threshold', () => {
    expect(SOFT_BOUNCE_THRESHOLD_N).toBeGreaterThanOrEqual(2);
  });

  it('does not suppress before reaching N distinct soft bounces', () => {
    // With N=3: priorCount 0,1 → this is the 1st/2nd event → not yet.
    expect(shouldSuppressSoftBounce(0, 3)).toBe(false);
    expect(shouldSuppressSoftBounce(1, 3)).toBe(false);
  });

  it('suppresses on the Nth distinct soft bounce', () => {
    // priorCount 2 → this is the 3rd event → cross.
    expect(shouldSuppressSoftBounce(2, 3)).toBe(true);
  });

  it('remains suppressed beyond N', () => {
    expect(shouldSuppressSoftBounce(5, 3)).toBe(true);
  });

  it('uses the default N when not provided', () => {
    expect(shouldSuppressSoftBounce(SOFT_BOUNCE_THRESHOLD_N - 1)).toBe(true);
    expect(shouldSuppressSoftBounce(SOFT_BOUNCE_THRESHOLD_N - 2)).toBe(false);
  });
});
