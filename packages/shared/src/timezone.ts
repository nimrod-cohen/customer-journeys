// DST-correct zoned↔UTC time helpers + an IANA validator — the SINGLE source of
// truth for "interpret a wall-clock in a timezone" (§8/§10/§9B). EXTRACTED from
// web/src/screens/BroadcastComposer.tsx so the broadcast scheduler AND campaign
// time math (waits, wait-until, hour-of-day windows) reuse ONE implementation.
// Behavior-preserving — the exact ISO outputs are locked by tests.

/** True iff `timeZone` is a real IANA zone (Intl accepts it without throwing). */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  try {
    // Throws RangeError on an invalid zone.
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The browser's IANA zone — the sensible default for "send at this time". */
function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** All IANA zones for a picker (falls back to a curated set on old engines).
 *  'UTC' (our canonical default) is guaranteed present — some engines list only
 *  'Etc/UTC' in Intl.supportedValuesOf, so we prepend 'UTC' when it is absent. */
export function timeZoneList(): string[] {
  const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  try {
    if (sv) {
      const list = sv('timeZone');
      return list.includes('UTC') ? list : ['UTC', ...list];
    }
  } catch {
    /* not supported — fall through */
  }
  const fallback = [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Europe/London',
    'Europe/Paris',
    'Asia/Jerusalem',
    'Asia/Kolkata',
    'Asia/Tokyo',
    'Australia/Sydney',
  ];
  const tz = browserTz();
  return fallback.includes(tz) ? fallback : [tz, ...fallback];
}

/** Offset (zone − UTC) in ms at a given UTC instant. */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const n = (k: string): number => Number(p[k] ?? 0);
  const asIfUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asIfUtc - utcMs;
}

/** Interpret a "YYYY-MM-DDTHH:mm" wall clock as being IN `timeZone` → UTC ISO. */
export function zonedInputToUtcIso(local: string, timeZone: string): string {
  const [date = '', time = '00:00'] = local.split('T');
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const [hh = 0, mm = 0] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Resolve the offset at the guessed instant, then re-resolve at the corrected
  // instant so we land on the right side of any DST change.
  let utc = guess - tzOffsetMs(guess, timeZone);
  utc = guess - tzOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

/** Wall-clock parts of a UTC instant read IN `timeZone` (1-based month; weekday 0=Sun..6=Sat). */
export interface ZonedComponents {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0=Sunday … 6=Saturday (matches Date.getUTCDay and the DSL daysOfWeek). */
  readonly weekday: number;
}

/**
 * Read a UTC instant's wall-clock parts AS SEEN IN `timeZone` (DST-aware). Used by
 * the hour-of-day window math to decide "what time / weekday is it for the
 * workspace right now". `weekday` is derived from the zoned Y-M-D (so it reflects
 * the local calendar day, not the UTC day) via Date.UTC(...).getUTCDay().
 */
export function zonedComponents(now: Date, timeZone: string): ZonedComponents {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(now)) p[part.type] = part.value;
  const n = (k: string): number => Number(p[k] ?? 0);
  const year = n('year');
  const month = n('month');
  const day = n('day');
  // Weekday for the LOCAL calendar day (build a UTC date from the zoned Y-M-D).
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour: n('hour'), minute: n('minute'), weekday };
}

/** An hour-of-day window spec (the runner's hour_of_day_window node fields). */
export interface HourWindow {
  /** Window start hour, integer 0–23 (inclusive). */
  readonly startHour: number;
  /** Window end hour, integer 0–23 (inclusive). May be < startHour (overnight). */
  readonly endHour: number;
  /** Optional allowed weekdays (0=Sun … 6=Sat); when omitted, every day is allowed. */
  readonly daysOfWeek?: readonly number[];
}

/** Add `days` to a Y-M-D triple, normalizing the calendar (via Date.UTC). */
function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Weekday (0=Sun..6=Sat) of a Y-M-D triple. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Is `weekday` allowed by the window (no daysOfWeek ⇒ all days allowed)? */
function dayAllowed(win: HourWindow, weekday: number): boolean {
  const days = win.daysOfWeek;
  if (days === undefined || days.length === 0) return true;
  return days.includes(weekday);
}

/** Format a Y-M-D-H wall clock as the "YYYY-MM-DDTHH:00" input zonedInputToUtcIso reads. */
function wallClock(year: number, month: number, day: number, hour: number): string {
  const pad2 = (v: number): string => String(v).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:00`;
}

/**
 * Is `now` INSIDE the allowed window in `timeZone` right now? The window is
 * inclusive of the whole end hour (endHour:59). `startHour > endHour` is an
 * OVERNIGHT (wrap-around) window. daysOfWeek (when present) is keyed on the
 * window-OPENING day — for an overnight window the post-midnight tail belongs to
 * the PRIOR day's opening (so a Fri-only 22..6 window is "open" Sat 02:00).
 */
export function isWindowOpen(now: Date, win: HourWindow, timeZone: string): boolean {
  const c = zonedComponents(now, timeZone);
  const { startHour, endHour } = win;
  if (startHour <= endHour) {
    // Same-day window [startHour, endHour].
    if (c.hour < startHour || c.hour > endHour) return false;
    return dayAllowed(win, c.weekday);
  }
  // Overnight window: [startHour..23] OR [0..endHour].
  if (c.hour >= startHour) {
    // Evening segment — opens TODAY; key the day on today.
    return dayAllowed(win, c.weekday);
  }
  if (c.hour <= endHour) {
    // Post-midnight tail — the window OPENED yesterday; key the day on yesterday.
    const y = addDays(c.year, c.month, c.day, -1);
    return dayAllowed(win, weekdayOf(y.year, y.month, y.day));
  }
  return false;
}

/**
 * The next instant the window OPENS in `timeZone`, or `null` when `now` is already
 * inside the window. DST-correct: the opening wall-clock (startHour:00 on the
 * opening day) is converted to UTC via the two-pass {@link zonedInputToUtcIso}, so
 * spring-forward / fall-back land on the right side of the transition. Scans
 * forward up to a bounded number of days (covers any daysOfWeek subset).
 */
export function nextWindowOpening(now: Date, win: HourWindow, timeZone: string): Date | null {
  if (isWindowOpen(now, win, timeZone)) return null;
  const c = zonedComponents(now, timeZone);
  // If we are BEFORE today's opening hour AND today is an allowed opening day, the
  // next opening is today at startHour. Otherwise advance to the next allowed day.
  // (For an overnight window the opening is always "today or later at startHour".)
  for (let i = 0; i < 8; i += 1) {
    const cand = addDays(c.year, c.month, c.day, i);
    const candWeekday = weekdayOf(cand.year, cand.month, cand.day);
    if (!dayAllowed(win, candWeekday)) continue;
    // On day 0 only accept an opening that is still in the FUTURE (now is before
    // startHour). On later days the startHour is always in the future.
    if (i === 0 && c.hour >= win.startHour) continue;
    const iso = zonedInputToUtcIso(wallClock(cand.year, cand.month, cand.day, win.startHour), timeZone);
    return new Date(iso);
  }
  // Unreachable for a valid window (daysOfWeek is non-empty when present), but keep
  // a safe fallback rather than returning null (which would mean "advance now").
  return null;
}

/** Inverse: a UTC ISO → "YYYY-MM-DDTHH:mm" wall clock in `timeZone` (for the input). */
export function utcIsoToZonedInput(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(d)) p[part.type] = part.value;
  return `${p.year ?? ''}-${p.month ?? ''}-${p.day ?? ''}T${p.hour ?? ''}:${p.minute ?? ''}`;
}
