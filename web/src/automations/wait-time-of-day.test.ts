import { describe, it, expect } from 'vitest';
import { readWaitUntilForm, writeWaitUntilForm, describeTimeOfDay, parseHhMm } from './node-config.js';

describe('wait-until: time of day', () => {
  it('round-trips "tomorrow at 09:00"', () => {
    const form = { ...readWaitUntilForm({ type: 'wait', next: 'x' } as never, 'UTC'), timeMode: 'timeOfDay' as const, todDays: 1, todTime: '09:00' };
    const node = writeWaitUntilForm(form, 'UTC') as unknown as Record<string, unknown>;
    expect(node.untilTimeOfDay).toEqual({ days: 1, hour: 9, minute: 0 });
    expect(node.until).toBeUndefined();
    expect(node.untilOffset).toBeUndefined();
    const back = readWaitUntilForm({ ...node, next: 'x' } as never, 'UTC');
    expect(back).toMatchObject({ timeMode: 'timeOfDay', todDays: 1, todTime: '09:00' });
  });
  it('labels and parses', () => {
    expect(describeTimeOfDay({ days: 1, hour: 9, minute: 0 })).toBe('tomorrow at 09:00');
    expect(describeTimeOfDay({ days: 0, hour: 18, minute: 30 })).toBe('the next 18:30');
    expect(describeTimeOfDay({ days: 4, hour: 7, minute: 5 })).toBe('in 4 days at 07:05');
    expect(parseHhMm('24:00')).toBeNull();
    expect(parseHhMm('9:05')).toEqual({ hour: 9, minute: 5 });
  });
});
