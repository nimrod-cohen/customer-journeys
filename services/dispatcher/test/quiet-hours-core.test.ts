import { describe, it, expect } from 'vitest';
import { isInQuietHours, nextSendableAt, type QuietSchedule } from '../src/core.js';

// §9 step 4 — quiet hours defer a send. Pure, with an injected clock. The schedule
// is PER WEEKDAY (0=Sun..6=Sat) → {startHour,endHour}, evaluated in a timezone; a
// null schedule = never quiet. Midnight-wrap (22:00–06:00) spans midnight. These
// tests use a UTC timezone with the SAME window every day, so times behave like the
// old single-window UTC check — plus a per-weekday case.
const TZ = 'UTC';
const everyDay = (startHour: number, endHour: number): QuietSchedule =>
  Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, { startHour, endHour }]));

describe('quiet-hours core', () => {
  describe('isInQuietHours', () => {
    it('null schedule → never quiet', () => {
      expect(isInQuietHours(new Date('2026-06-10T03:00:00.000Z'), null, TZ)).toBe(false);
    });

    it('same-day window (09:00–17:00): inside is quiet, outside is not', () => {
      const s = everyDay(9, 17);
      expect(isInQuietHours(new Date('2026-06-10T12:00:00.000Z'), s, TZ)).toBe(true);
      expect(isInQuietHours(new Date('2026-06-10T08:59:00.000Z'), s, TZ)).toBe(false);
      expect(isInQuietHours(new Date('2026-06-10T17:00:00.000Z'), s, TZ)).toBe(false);
    });

    it('midnight-wrap window (22:00–06:00): late night and early morning are quiet', () => {
      const s = everyDay(22, 6);
      expect(isInQuietHours(new Date('2026-06-10T23:30:00.000Z'), s, TZ)).toBe(true);
      expect(isInQuietHours(new Date('2026-06-10T02:00:00.000Z'), s, TZ)).toBe(true);
      expect(isInQuietHours(new Date('2026-06-10T12:00:00.000Z'), s, TZ)).toBe(false);
      expect(isInQuietHours(new Date('2026-06-10T06:00:00.000Z'), s, TZ)).toBe(false);
    });

    it('only the configured weekday is quiet', () => {
      const night = new Date('2026-06-10T23:00:00.000Z');
      const s: QuietSchedule = { [night.getUTCDay()]: { startHour: 22, endHour: 6 } };
      expect(isInQuietHours(night, s, TZ)).toBe(true); // configured day
      expect(isInQuietHours(new Date('2026-06-11T23:00:00.000Z'), s, TZ)).toBe(false); // next day, not configured
    });

    it('evaluates the hour in the given timezone', () => {
      // 20:00 UTC = 22:00 in Israel (UTC+2 in June). Quiet 22–06 every day.
      const s = everyDay(22, 6);
      expect(isInQuietHours(new Date('2026-06-10T20:00:00.000Z'), s, 'Asia/Jerusalem')).toBe(true);
      expect(isInQuietHours(new Date('2026-06-10T20:00:00.000Z'), s, 'UTC')).toBe(false);
    });
  });

  describe('nextSendableAt', () => {
    it('returns the same instant when not in quiet hours', () => {
      const now = new Date('2026-06-10T12:00:00.000Z');
      expect(nextSendableAt(now, everyDay(22, 6), TZ).toISOString()).toBe(now.toISOString());
    });

    it('same-day window: defers to the window end', () => {
      const now = new Date('2026-06-10T12:00:00.000Z');
      expect(nextSendableAt(now, everyDay(9, 17), TZ).toISOString()).toBe('2026-06-10T17:00:00.000Z');
    });

    it('midnight-wrap, late night: defers to the end hour the next day', () => {
      const now = new Date('2026-06-10T23:30:00.000Z');
      expect(nextSendableAt(now, everyDay(22, 6), TZ).toISOString()).toBe('2026-06-11T06:00:00.000Z');
    });

    it('midnight-wrap, early morning: defers to the end hour the same day', () => {
      const now = new Date('2026-06-10T02:00:00.000Z');
      expect(nextSendableAt(now, everyDay(22, 6), TZ).toISOString()).toBe('2026-06-10T06:00:00.000Z');
    });

    it('null schedule → same instant (never defers)', () => {
      const now = new Date('2026-06-10T02:00:00.000Z');
      expect(nextSendableAt(now, null, TZ).toISOString()).toBe(now.toISOString());
    });
  });
});
