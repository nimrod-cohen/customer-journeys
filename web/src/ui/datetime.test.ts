import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime } from './datetime.js';

// A fixed instant: 2026-07-01 13:09:12 UTC. In dd/mm/yyyy that's 01/07/2026 (NOT 07/01).
const ISO = '2026-07-01T13:09:12.000Z';

describe('formatDate (dd/mm/yyyy)', () => {
  it('renders day-first dd/mm/yyyy (the system-wide format)', () => {
    expect(formatDate(ISO, 'UTC')).toBe('01/07/2026');
  });
  it('accepts an epoch-ms number and a Date', () => {
    const ms = Date.parse(ISO);
    expect(formatDate(ms, 'UTC')).toBe('01/07/2026');
    expect(formatDate(new Date(ms), 'UTC')).toBe('01/07/2026');
  });
  it('is fail-soft on an unparseable value (returns the raw input)', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });
});

describe('formatDateTime (dd/mm/yyyy + 24h time)', () => {
  it('renders dd/mm/yyyy, HH:mm:ss in the given zone', () => {
    expect(formatDateTime(ISO, 'UTC')).toBe('01/07/2026, 13:09:12');
  });
  it('honors a timeZone offset (Asia/Jerusalem is UTC+3 in July → 16:09)', () => {
    expect(formatDateTime(ISO, 'Asia/Jerusalem')).toBe('01/07/2026, 16:09:12');
  });
  it('never produces US m/d/yyyy ordering', () => {
    // The day (01) precedes the month (07); the reverse "07/01" would be the US bug.
    expect(formatDateTime(ISO, 'UTC').startsWith('01/07/2026')).toBe(true);
  });
});
