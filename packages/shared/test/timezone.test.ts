// DST-correct zoned↔UTC helpers + an IANA validator (§8/§10/§9B). EXTRACTED from
// web/src/screens/BroadcastComposer.tsx so the broadcast scheduler AND campaign
// time math share ONE implementation. These tests LOCK the exact ISO outputs so the
// extraction is behavior-preserving.
import { describe, it, expect } from 'vitest';
import {
  isValidTimeZone,
  tzOffsetMs,
  zonedInputToUtcIso,
  utcIsoToZonedInput,
  timeZoneList,
} from '../src/timezone.js';

describe('isValidTimeZone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Asia/Jerusalem')).toBe(true);
  });
  it('rejects bogus zones', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('America/Fake')).toBe(false);
  });
});

describe('tzOffsetMs (DST boundary)', () => {
  const H = 60 * 60 * 1000;
  it('America/New_York is -5h in January and -4h in July', () => {
    const jan = Date.UTC(2026, 0, 15, 12, 0); // winter (EST)
    const jul = Date.UTC(2026, 6, 15, 12, 0); // summer (EDT)
    expect(tzOffsetMs(jan, 'America/New_York')).toBe(-5 * H);
    expect(tzOffsetMs(jul, 'America/New_York')).toBe(-4 * H);
  });
});

describe('zonedInputToUtcIso / utcIsoToZonedInput', () => {
  it('resolves the spring-forward gap deterministically (two-pass)', () => {
    // 2026-03-08 02:30 in America/New_York is inside the DST gap (clocks jump
    // 02:00→03:00). The two-pass re-resolution lands on the post-jump offset (-4h),
    // so 02:30 local resolves to 06:30Z. Lock the exact ISO.
    expect(zonedInputToUtcIso('2026-03-08T02:30', 'America/New_York')).toBe('2026-03-08T06:30:00.000Z');
  });

  it('round-trips a non-DST instant', () => {
    const x = '2026-01-15T09:00';
    expect(utcIsoToZonedInput(zonedInputToUtcIso(x, 'America/New_York'), 'America/New_York')).toBe(x);
    expect(utcIsoToZonedInput(zonedInputToUtcIso(x, 'Asia/Jerusalem'), 'Asia/Jerusalem')).toBe(x);
  });

  it('UTC is the identity zone', () => {
    expect(zonedInputToUtcIso('2026-06-19T12:00', 'UTC')).toBe('2026-06-19T12:00:00.000Z');
  });
});

describe('timeZoneList', () => {
  it('returns a non-empty list including UTC', () => {
    const list = timeZoneList();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list).toContain('UTC');
  });

  it('falls back gracefully when Intl.supportedValuesOf is absent', () => {
    const intl = Intl as unknown as { supportedValuesOf?: unknown };
    const original = intl.supportedValuesOf;
    try {
      delete intl.supportedValuesOf;
      const list = timeZoneList();
      expect(list.length).toBeGreaterThan(0);
      expect(list).toContain('UTC');
    } finally {
      intl.supportedValuesOf = original;
    }
  });
});
