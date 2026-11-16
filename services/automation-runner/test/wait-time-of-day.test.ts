// "Wait until N days later at HH:MM" (workspace timezone): target math + the gate.
import { describe, it, expect } from 'vitest';
import { timeOfDayTarget, decideRichWait } from '../src/core.js';
import { validateAutomationDefinition, type WaitNode } from '../src/dsl.js';

const TZ = 'Asia/Jerusalem'; // UTC+2 in winter, +3 in summer

describe('timeOfDayTarget', () => {
  it('tomorrow at 09:00 in the workspace timezone', () => {
    // 2026-01-14 21:00 local (19:00Z) → 2026-01-15 09:00 local (07:00Z)
    expect(timeOfDayTarget({ days: 1, hour: 9, minute: 0 }, new Date('2026-01-14T19:00:00Z'), TZ).toISOString()).toBe('2026-01-15T07:00:00.000Z');
    // just after local midnight still means the NEXT calendar day
    expect(timeOfDayTarget({ days: 1, hour: 9, minute: 0 }, new Date('2026-01-14T22:30:00Z'), TZ).toISOString()).toBe('2026-01-16T07:00:00.000Z');
  });
  it('days 0 = the next 09:00 (today if still ahead, else tomorrow)', () => {
    expect(timeOfDayTarget({ days: 0, hour: 9, minute: 0 }, new Date('2026-01-14T04:00:00Z'), TZ).toISOString()).toBe('2026-01-14T07:00:00.000Z');
    expect(timeOfDayTarget({ days: 0, hour: 9, minute: 0 }, new Date('2026-01-14T10:00:00Z'), TZ).toISOString()).toBe('2026-01-15T07:00:00.000Z');
  });
  it('keeps the wall-clock time across a DST change', () => {
    // Israel moves to summer time on Fri 2026-03-27. Thu 12:00 local → Fri 09:00 local (+03:00).
    expect(timeOfDayTarget({ days: 1, hour: 9, minute: 30 }, new Date('2026-03-26T10:00:00Z'), TZ).toISOString()).toBe('2026-03-27T06:30:00.000Z');
  });
});

describe('wait node with untilTimeOfDay', () => {
  const node: WaitNode = { type: 'wait', untilTimeOfDay: { days: 1, hour: 9, minute: 0 }, next: 'x' };
  it('parks until the target, then proceeds', () => {
    const now = new Date('2026-01-14T19:00:00Z');
    const first = decideRichWait(node, now, TZ, { conditionMet: true, resolvedAnchor: null, pin: null });
    expect(first.advance).toBe(false);
    expect(first.nextRunAt?.toISOString()).toBe('2026-01-15T07:00:00.000Z');
    const later = decideRichWait(node, new Date('2026-01-15T07:00:01Z'), TZ, { conditionMet: true, resolvedAnchor: null, pin: first.pinToPersist });
    expect(later.advance).toBe(true);
  });
  it('validates the fields and allows only one time gate', () => {
    const def = (w: Record<string, unknown>) => ({ startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 'w' }, w: { type: 'wait', next: 'x', ...w }, x: { type: 'exit' } } });
    expect(() => validateAutomationDefinition(def({ untilTimeOfDay: { days: 1, hour: 9, minute: 0 } }))).not.toThrow();
    expect(() => validateAutomationDefinition(def({ untilTimeOfDay: { days: 1, hour: 24, minute: 0 } }))).toThrow(/untilTimeOfDay/);
    expect(() =>
      validateAutomationDefinition(def({ untilTimeOfDay: { days: 1, hour: 9, minute: 0 }, untilOffset: { amount: 1, unit: 'days', anchor: 'now' } })),
    ).toThrow(/only one of/);
  });
});
