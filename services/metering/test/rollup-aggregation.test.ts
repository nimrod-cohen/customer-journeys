// §20 usage rollups — PURE statement builders (§16A). The dispatcher already
// increments emails_sent per-send; the monthly rollup DERIVES the authoritative
// total from messages_log and writes it SET-to-truth (ON CONFLICT DO UPDATE SET
// value = EXCLUDED.value), NOT additive — so re-running is idempotent. These
// unit tests assert the exact SQL shape; the reconcile is proven against real PG
// in the integration tier.
import { describe, it, expect } from 'vitest';
import {
  monthBucket,
  periodForDate,
  buildEmailsSentRollup,
  buildEventsIngestedRollup,
} from '../src/usage.js';

describe('monthBucket / periodForDate', () => {
  it('returns the UTC first-of-month YYYY-MM-01', () => {
    expect(monthBucket(new Date('2026-06-17T23:59:59.999Z'))).toBe('2026-06-01');
    expect(monthBucket(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01');
    expect(monthBucket(new Date('2026-12-31T12:00:00.000Z'))).toBe('2026-12-01');
  });

  it('uses UTC, not local time (no off-by-one at month edge)', () => {
    // 2026-07-01T00:30 UTC is July regardless of the runner's timezone.
    expect(monthBucket(new Date('2026-07-01T00:30:00.000Z'))).toBe('2026-07-01');
  });

  it('periodForDate is an alias returning the month bucket string', () => {
    expect(periodForDate(new Date('2026-06-17T00:00:00Z'))).toBe('2026-06-01');
  });
});

describe('buildEmailsSentRollup (SET-to-truth)', () => {
  const ws = '11111111-1111-1111-1111-111111111111';

  it('binds workspace_id at $1 and counts sent messages_log rows in the month', () => {
    const stmt = buildEmailsSentRollup(ws, '2026-06-01');
    expect(stmt.values[0]).toBe(ws);
    expect(stmt.text).toMatch(/messages_log/);
    expect(stmt.text).toMatch(/status\s*=\s*'sent'/);
    // workspace_id must be the first bound parameter (tenant guard).
    expect(stmt.text).toMatch(/workspace_id\s*=\s*\$1/);
  });

  it('upserts with SET-to-truth (DO UPDATE SET value = EXCLUDED.value), NOT additive', () => {
    const stmt = buildEmailsSentRollup(ws, '2026-06-01');
    expect(stmt.text).toMatch(/ON CONFLICT/i);
    expect(stmt.text).toMatch(/DO UPDATE SET\s+value\s*=\s*EXCLUDED\.value/i);
    // must NOT be the additive dispatcher form.
    expect(stmt.text).not.toMatch(/usage_counters\.value\s*\+/i);
  });

  it("writes the emails_sent metric for the given period", () => {
    const stmt = buildEmailsSentRollup(ws, '2026-06-01');
    expect(stmt.values).toContain('emails_sent');
    expect(stmt.values).toContain('2026-06-01');
  });

  it('throws on a falsy workspaceId (tenant guard)', () => {
    expect(() => buildEmailsSentRollup('', '2026-06-01')).toThrow();
  });
});

describe('buildEventsIngestedRollup (SET-to-truth from events)', () => {
  const ws = '22222222-2222-2222-2222-222222222222';

  it('derives the count from events and upserts SET-to-truth', () => {
    const stmt = buildEventsIngestedRollup(ws, '2026-06-01');
    expect(stmt.values[0]).toBe(ws);
    expect(stmt.text).toMatch(/from events/i);
    expect(stmt.text).toMatch(/DO UPDATE SET\s+value\s*=\s*EXCLUDED\.value/i);
    expect(stmt.values).toContain('events_ingested');
  });

  it('throws on a falsy workspaceId', () => {
    expect(() => buildEventsIngestedRollup('', '2026-06-01')).toThrow();
  });
});
