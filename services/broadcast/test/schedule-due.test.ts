import { describe, it, expect } from 'vitest';
import { isScheduleDue, buildDueScheduledBroadcastsQuery } from '../src/core.js';

// §9A — scheduled_at null = send now; otherwise due when scheduled_at <= now.
describe('isScheduleDue', () => {
  const now = new Date('2026-06-07T12:00:00.000Z');

  it('null scheduled_at is always due (send now)', () => {
    expect(isScheduleDue(null, now)).toBe(true);
  });

  it('a past schedule is due', () => {
    expect(isScheduleDue(new Date('2026-06-07T11:59:59.000Z'), now)).toBe(true);
  });

  it('the exact instant is due', () => {
    expect(isScheduleDue(new Date('2026-06-07T12:00:00.000Z'), now)).toBe(true);
  });

  it('a future schedule is NOT due', () => {
    expect(isScheduleDue(new Date('2026-06-07T12:00:01.000Z'), now)).toBe(false);
  });

  it('accepts an ISO string for scheduled_at', () => {
    expect(isScheduleDue('2026-06-07T11:00:00.000Z', now)).toBe(true);
    expect(isScheduleDue('2026-06-07T13:00:00.000Z', now)).toBe(false);
  });
});

describe('buildDueScheduledBroadcastsQuery', () => {
  it('selects scheduled broadcasts whose time has come', () => {
    const now = new Date('2026-06-07T12:00:00.000Z');
    const stmt = buildDueScheduledBroadcastsQuery(now);
    const t = stmt.text.replace(/\s+/g, ' ');
    expect(t).toMatch(/FROM broadcasts/i);
    expect(t).toMatch(/status = 'scheduled'/i);
    expect(t).toMatch(/scheduled_at <= \$1/i);
    expect(stmt.values[0]).toEqual(now);
  });
});
