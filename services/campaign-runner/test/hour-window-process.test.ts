// processNode for an hour_of_day_window node (§9B, phase 2). The decision is PURE
// + tz-aware: inside the allowed window → advance; outside → stay with
// nextRunAt = the next window opening (ws-tz, DST-correct). The workspace tz is
// passed in explicitly (threaded from the enrollment's workspace, never hard-coded).
import { describe, it, expect } from 'vitest';
import { processNode, type EnrollmentState } from '../src/core.js';
import type { HourOfDayWindowNode } from '../src/dsl.js';
import { nextWindowOpening } from '@cdp/shared';

const WIN: HourOfDayWindowNode = { type: 'hour_of_day_window', startHour: 9, endHour: 17, next: 'x' };

function state(over: Partial<EnrollmentState> = {}): EnrollmentState {
  return {
    id: 'e1',
    workspace_id: 'w1',
    campaign_id: 'c1',
    profile_id: 'p1',
    current_node: 'win',
    status: 'active',
    next_run_at: null,
    updated_at: '2026-06-19T00:00:00.000Z',
    ...over,
  };
}

describe('processNode hour_of_day_window (tz-aware)', () => {
  it('inside the window (arrived) → advance to next, no side effects', () => {
    const now = new Date('2026-06-19T16:00:00.000Z'); // 12:00 NY
    const r = processNode(WIN, state(), false, now, 'arrived', 'America/New_York');
    expect(r.disposition).toBe('advance');
    expect((r as { nextNode: string }).nextNode).toBe('x');
    expect(r.sideEffects).toEqual([]);
  });

  it('outside the window → stay, nextRunAt = next opening (future), nextNode=next', () => {
    const now = new Date('2026-06-19T11:00:00.000Z'); // 07:00 NY, before 09:00
    const r = processNode(WIN, state(), false, now, 'arrived', 'America/New_York');
    expect(r.disposition).toBe('stay');
    const stay = r as { nextNode: string; nextRunAt: Date };
    expect(stay.nextNode).toBe('x');
    expect(stay.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    expect(stay.nextRunAt.toISOString()).toBe(nextWindowOpening(now, WIN, 'America/New_York')!.toISOString());
  });

  it('resumed on a parked window whose next_run_at elapsed AND now inside → advance', () => {
    const now = new Date('2026-06-19T16:00:00.000Z'); // 12:00 NY, inside
    const r = processNode(
      WIN,
      state({ next_run_at: '2026-06-19T13:00:00.000Z' }),
      false,
      now,
      'resumed',
      'America/New_York',
    );
    expect(r.disposition).toBe('advance');
  });

  it('resumed but STILL outside (e.g. day moved) → re-park with a fresh opening', () => {
    // daysOfWeek Mon/Wed; now is a Tuesday inside the hour range → still outside.
    const win: HourOfDayWindowNode = { ...WIN, daysOfWeek: [1, 3] };
    const now = new Date('2026-06-23T16:00:00.000Z'); // Tue 12:00 NY
    const r = processNode(win, state({ next_run_at: '2026-06-23T00:00:00.000Z' }), false, now, 'resumed', 'America/New_York');
    expect(r.disposition).toBe('stay');
    const stay = r as { nextRunAt: Date };
    expect(stay.nextRunAt.toISOString()).toBe(nextWindowOpening(now, win, 'America/New_York')!.toISOString());
  });

  it('tz is threaded, not hard-coded: UTC vs Asia/Jerusalem differ', () => {
    const now = new Date('2026-06-19T07:00:00.000Z');
    // 07:00 UTC is before 09:00 UTC → stay; opening today 09:00Z.
    const utc = processNode(WIN, state(), false, now, 'arrived', 'UTC');
    expect(utc.disposition).toBe('stay');
    expect((utc as { nextRunAt: Date }).nextRunAt.toISOString()).toBe('2026-06-19T09:00:00.000Z');
    // 07:00 UTC == 10:00 Jerusalem (UTC+3 in June) → INSIDE 9..17 → advance.
    const jm = processNode(WIN, state(), false, now, 'arrived', 'Asia/Jerusalem');
    expect(jm.disposition).toBe('advance');
  });

  it('no daysOfWeek treats every day as allowed', () => {
    const win: HourOfDayWindowNode = { type: 'hour_of_day_window', startHour: 0, endHour: 23, next: 'x' };
    const now = new Date('2026-06-23T16:00:00.000Z'); // a Tuesday
    const r = processNode(win, state(), false, now, 'arrived', 'America/New_York');
    expect(r.disposition).toBe('advance');
  });
});
