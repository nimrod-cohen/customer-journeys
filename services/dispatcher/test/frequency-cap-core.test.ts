import { describe, it, expect } from 'vitest';
import { isOverCap, windowStart } from '../src/core.js';

// §9 step 3 — frequency cap is per workspace (counted from messages_log). Pure
// logic, injected clock. windowStart(now, capPerDays) gives the lower bound of
// the rolling window; isOverCap compares the recent send count to the cap.
describe('frequency-cap core', () => {
  describe('windowStart', () => {
    it('subtracts capPerDays days from now', () => {
      const now = new Date('2026-06-10T12:00:00.000Z');
      expect(windowStart(now, 7).toISOString()).toBe('2026-06-03T12:00:00.000Z');
    });

    it('handles a 1-day window', () => {
      const now = new Date('2026-06-10T00:00:00.000Z');
      expect(windowStart(now, 1).toISOString()).toBe('2026-06-09T00:00:00.000Z');
    });
  });

  describe('isOverCap', () => {
    // The cap is a MAX number of sends allowed in the window. Once the recent
    // count reaches the cap, the next send is blocked (>=).
    it('is false when recent count is below the cap', () => {
      expect(isOverCap(0, 3)).toBe(false);
      expect(isOverCap(2, 3)).toBe(false);
    });

    it('is true when recent count equals or exceeds the cap', () => {
      expect(isOverCap(3, 3)).toBe(true);
      expect(isOverCap(5, 3)).toBe(true);
    });

    it('treats a null/undefined/zero cap as no cap (never over)', () => {
      expect(isOverCap(100, null)).toBe(false);
      expect(isOverCap(100, undefined)).toBe(false);
      expect(isOverCap(100, 0)).toBe(false);
    });
  });
});
