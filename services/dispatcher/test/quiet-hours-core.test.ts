import { describe, it, expect } from 'vitest';
import { isInQuietHours, nextSendableAt, type QuietHoursConfig } from '../src/core.js';

// §9 step 4 — quiet hours defer a send. Pure, with an injected clock. Config is
// {start, end} hours in UTC (this phase: UTC, no per-recipient tz). A null config
// means quiet hours are never in effect. Midnight-wrap (e.g. 22:00–06:00) is
// handled by treating start > end as a window that spans midnight.
describe('quiet-hours core', () => {
  describe('isInQuietHours', () => {
    it('null config → never quiet', () => {
      const now = new Date('2026-06-10T03:00:00.000Z');
      expect(isInQuietHours(now, null)).toBe(false);
    });

    it('same-day window (09:00–17:00): inside is quiet, outside is not', () => {
      const cfg: QuietHoursConfig = { startHour: 9, endHour: 17 };
      expect(isInQuietHours(new Date('2026-06-10T12:00:00.000Z'), cfg)).toBe(true);
      expect(isInQuietHours(new Date('2026-06-10T08:59:00.000Z'), cfg)).toBe(false);
      expect(isInQuietHours(new Date('2026-06-10T17:00:00.000Z'), cfg)).toBe(false);
    });

    it('midnight-wrap window (22:00–06:00): late night and early morning are quiet', () => {
      const cfg: QuietHoursConfig = { startHour: 22, endHour: 6 };
      expect(isInQuietHours(new Date('2026-06-10T23:30:00.000Z'), cfg)).toBe(true);
      expect(isInQuietHours(new Date('2026-06-10T02:00:00.000Z'), cfg)).toBe(true);
      expect(isInQuietHours(new Date('2026-06-10T12:00:00.000Z'), cfg)).toBe(false);
      expect(isInQuietHours(new Date('2026-06-10T06:00:00.000Z'), cfg)).toBe(false);
    });
  });

  describe('nextSendableAt', () => {
    it('returns the same instant when not in quiet hours', () => {
      const cfg: QuietHoursConfig = { startHour: 22, endHour: 6 };
      const now = new Date('2026-06-10T12:00:00.000Z');
      expect(nextSendableAt(now, cfg).toISOString()).toBe(now.toISOString());
    });

    it('same-day window: defers to the window end on the same day', () => {
      const cfg: QuietHoursConfig = { startHour: 9, endHour: 17 };
      const now = new Date('2026-06-10T12:00:00.000Z');
      expect(nextSendableAt(now, cfg).toISOString()).toBe('2026-06-10T17:00:00.000Z');
    });

    it('midnight-wrap, late night: defers to the end hour the next day', () => {
      const cfg: QuietHoursConfig = { startHour: 22, endHour: 6 };
      const now = new Date('2026-06-10T23:30:00.000Z');
      expect(nextSendableAt(now, cfg).toISOString()).toBe('2026-06-11T06:00:00.000Z');
    });

    it('midnight-wrap, early morning: defers to the end hour the same day', () => {
      const cfg: QuietHoursConfig = { startHour: 22, endHour: 6 };
      const now = new Date('2026-06-10T02:00:00.000Z');
      expect(nextSendableAt(now, cfg).toISOString()).toBe('2026-06-10T06:00:00.000Z');
    });

    it('null config → same instant (never defers)', () => {
      const now = new Date('2026-06-10T02:00:00.000Z');
      expect(nextSendableAt(now, null).toISOString()).toBe(now.toISOString());
    });
  });
});
