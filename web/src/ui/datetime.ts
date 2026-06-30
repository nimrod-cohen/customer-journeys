// User-facing date/time DISPLAY formatting — dd/mm/yyyy EVERYWHERE (en-GB locale, 24-hour
// time, the convention for dd/mm/yyyy regions). This is the single source of truth for
// showing a date to the user; every screen's local fmt/fmtDate/whenLabel helper delegates
// here so the format is consistent.
//
// NOTE: internal date MATH (zoned↔UTC conversion, datetime-local input values) stays in
// @cdp/shared/timezone — that uses en-US/en-CA deliberately for PARSING, not display, and
// must NOT be routed through here.

const DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};
const DATE_OPTS: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' };

// Cache the zone-less formatters (the common case); a timeZone variant is built on demand.
const DATETIME = new Intl.DateTimeFormat('en-GB', DATETIME_OPTS);
const DATE = new Intl.DateTimeFormat('en-GB', DATE_OPTS);

function toDate(value: number | string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** dd/mm/yyyy, HH:mm:ss. Accepts a Date, ISO string, or epoch-ms number. Returns the raw
 *  input string for an unparseable value (fail-soft, like the helpers it replaces). */
export function formatDateTime(value: number | string | Date, timeZone?: string): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return (timeZone ? new Intl.DateTimeFormat('en-GB', { ...DATETIME_OPTS, timeZone }) : DATETIME).format(d);
}

/** dd/mm/yyyy (date only). */
export function formatDate(value: number | string | Date, timeZone?: string): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return (timeZone ? new Intl.DateTimeFormat('en-GB', { ...DATE_OPTS, timeZone }) : DATE).format(d);
}
