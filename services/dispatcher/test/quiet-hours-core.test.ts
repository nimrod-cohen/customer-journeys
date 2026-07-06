import { describe, it, expect } from 'vitest';
import { isInQuietHours, nextSendableAt, type QuietSchedule } from '../src/core.js';

// §9 step 4 — quiet hours defer a send. Pure, with an injected clock. The schedule
// is a LIST of windows { startDay, startMinute, endDay, endMinute } (day 0=Sun..6=Sat,
// minutes 0..1439), evaluated in a timezone; a null/empty schedule = never quiet. A
// window may span days (Fri→Sat) and wrap the week (Sat→Sun). Weekdays are derived
// from the test dates so the cases hold regardless of the calendar.
const TZ = 'UTC';
const win = (startDay: number, startMinute: number, endDay: number, endMinute: number): QuietSchedule => [
  { startDay, startMinute, endDay, endMinute },
];
const wd = (iso: string) => new Date(iso).getUTCDay();

describe('quiet-hours core', () => {
  describe('isInQuietHours', () => {
    it('null/empty schedule → never quiet', () => {
      const now = new Date('2026-06-10T03:00:00.000Z');
      expect(isInQuietHours(now, null, TZ)).toBe(false);
      expect(isInQuietHours(now, [], TZ)).toBe(false);
    });

    it('same-day window (09:00–17:00): inside is quiet, edges are not', () => {
      const d = wd('2026-06-10T12:00:00.000Z');
      const s = win(d, 9 * 60, d, 17 * 60);
      expect(isInQuietHours(new Date('2026-06-10T12:00:00.000Z'), s, TZ)).toBe(true);
      expect(isInQuietHours(new Date('2026-06-10T08:59:00.000Z'), s, TZ)).toBe(false);
      expect(isInQuietHours(new Date('2026-06-10T17:00:00.000Z'), s, TZ)).toBe(false);
    });

    it('cross-day window (Wed 22:00 → Thu 06:00): late night and next early morning are quiet', () => {
      const wed = wd('2026-06-10T23:30:00.000Z');
      const s = win(wed, 22 * 60, (wed + 1) % 7, 6 * 60);
      expect(isInQuietHours(new Date('2026-06-10T23:30:00.000Z'), s, TZ)).toBe(true); // Wed 23:30
      expect(isInQuietHours(new Date('2026-06-11T02:00:00.000Z'), s, TZ)).toBe(true); // Thu 02:00
      expect(isInQuietHours(new Date('2026-06-10T12:00:00.000Z'), s, TZ)).toBe(false); // Wed noon
      expect(isInQuietHours(new Date('2026-06-11T06:00:00.000Z'), s, TZ)).toBe(false); // Thu 06:00
    });

    it('half-hour granularity (09:30 → 16:30)', () => {
      const d = wd('2026-06-10T12:00:00.000Z');
      const s = win(d, 9 * 60 + 30, d, 16 * 60 + 30);
      expect(isInQuietHours(new Date('2026-06-10T09:29:00.000Z'), s, TZ)).toBe(false);
      expect(isInQuietHours(new Date('2026-06-10T09:30:00.000Z'), s, TZ)).toBe(true);
      expect(isInQuietHours(new Date('2026-06-10T16:30:00.000Z'), s, TZ)).toBe(false);
    });

    it('evaluates day + hour in the given timezone', () => {
      const now = new Date('2026-06-10T20:00:00.000Z'); // 23:00 in Israel (IDT, UTC+3)
      const d = now.getUTCDay();
      const s = win(d, 22 * 60, d, 23 * 60 + 59); // that weekday 22:00–23:59
      expect(isInQuietHours(now, s, 'Asia/Jerusalem')).toBe(true); // 23:00 local
      expect(isInQuietHours(now, s, 'UTC')).toBe(false); // 20:00 local
    });

    it('a moment is quiet if it falls in ANY window', () => {
      const d = wd('2026-06-10T12:00:00.000Z');
      const s: QuietSchedule = [
        { startDay: d, startMinute: 8 * 60, endDay: d, endMinute: 9 * 60 },
        { startDay: d, startMinute: 13 * 60, endDay: d, endMinute: 14 * 60 },
      ];
      expect(isInQuietHours(new Date('2026-06-10T13:30:00.000Z'), s, TZ)).toBe(true); // 2nd window
      expect(isInQuietHours(new Date('2026-06-10T10:00:00.000Z'), s, TZ)).toBe(false); // gap between
    });
  });

  describe('nextSendableAt', () => {
    it('returns the same instant when not in quiet hours', () => {
      const d = wd('2026-06-10T12:00:00.000Z');
      const now = new Date('2026-06-10T12:00:00.000Z');
      expect(nextSendableAt(now, win(d, 22 * 60, d, 23 * 60), TZ).toISOString()).toBe(now.toISOString());
    });

    it('same-day window: defers to the window end', () => {
      const d = wd('2026-06-10T12:00:00.000Z');
      const now = new Date('2026-06-10T12:00:00.000Z');
      expect(nextSendableAt(now, win(d, 9 * 60, d, 17 * 60), TZ).toISOString()).toBe('2026-06-10T17:00:00.000Z');
    });

    it('cross-day window, late night: defers to the end the next day', () => {
      const wed = wd('2026-06-10T23:30:00.000Z');
      const now = new Date('2026-06-10T23:30:00.000Z');
      const s = win(wed, 22 * 60, (wed + 1) % 7, 6 * 60);
      expect(nextSendableAt(now, s, TZ).toISOString()).toBe('2026-06-11T06:00:00.000Z');
    });

    it('half-hour defer target (→ 16:30)', () => {
      const d = wd('2026-06-10T12:00:00.000Z');
      const now = new Date('2026-06-10T12:00:00.000Z');
      expect(nextSendableAt(now, win(d, 9 * 60, d, 16 * 60 + 30), TZ).toISOString()).toBe('2026-06-10T16:30:00.000Z');
    });

    it('null schedule → same instant (never defers)', () => {
      const now = new Date('2026-06-10T02:00:00.000Z');
      expect(nextSendableAt(now, null, TZ).toISOString()).toBe(now.toISOString());
    });
  });
});
