import { describe, it, expect } from 'vitest';
import {
  computeWaitNextRunAt,
  isWaitElapsed,
  parseIso8601DurationSeconds,
} from '../src/core.js';
import type { WaitNode } from '../src/dsl.js';

const NOW = new Date('2026-06-07T12:00:00.000Z');

describe('parseIso8601DurationSeconds', () => {
  it('parses common durations', () => {
    expect(parseIso8601DurationSeconds('PT30S')).toBe(30);
    expect(parseIso8601DurationSeconds('PT5M')).toBe(300);
    expect(parseIso8601DurationSeconds('PT2H')).toBe(7200);
    expect(parseIso8601DurationSeconds('P1D')).toBe(86400);
    expect(parseIso8601DurationSeconds('P2DT3H4M5S')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseIso8601DurationSeconds('P1W')).toBe(7 * 86400);
  });

  it('throws on malformed durations', () => {
    expect(() => parseIso8601DurationSeconds('garbage')).toThrow();
    expect(() => parseIso8601DurationSeconds('P')).toThrow();
    expect(() => parseIso8601DurationSeconds('')).toThrow();
  });
});

describe('computeWaitNextRunAt', () => {
  it('handles {seconds}', () => {
    const node: WaitNode = { type: 'wait', delay: { seconds: 120 }, next: 'x' };
    expect(computeWaitNextRunAt(node, NOW).toISOString()).toBe('2026-06-07T12:02:00.000Z');
  });

  it('handles an ISO-8601 duration string', () => {
    const node: WaitNode = { type: 'wait', delay: 'PT1H', next: 'x' };
    expect(computeWaitNextRunAt(node, NOW).toISOString()).toBe('2026-06-07T13:00:00.000Z');
  });

  it('handles an absolute until', () => {
    const node: WaitNode = { type: 'wait', until: '2026-12-25T00:00:00.000Z', next: 'x' };
    expect(computeWaitNextRunAt(node, NOW).toISOString()).toBe('2026-12-25T00:00:00.000Z');
  });

  it('throws when neither delay nor until is present', () => {
    expect(() => computeWaitNextRunAt({ type: 'wait', next: 'x' } as WaitNode, NOW)).toThrow();
  });
});

describe('isWaitElapsed', () => {
  it('null next_run_at is elapsed', () => {
    expect(isWaitElapsed(null, NOW)).toBe(true);
  });
  it('past is elapsed; future is not', () => {
    expect(isWaitElapsed('2026-06-07T11:59:59.000Z', NOW)).toBe(true);
    expect(isWaitElapsed('2026-06-07T12:00:01.000Z', NOW)).toBe(false);
  });
});
