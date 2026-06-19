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
