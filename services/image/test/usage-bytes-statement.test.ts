import { describe, it, expect } from 'vitest';
import { buildImageBytesUpsert, monthBucket } from '../src/usage.js';

// §11 / §20: record image storage bytes into usage_counters for per-workspace
// cost attribution. The upsert is ADDITIVE (value = value + EXCLUDED.value) on
// ON CONFLICT (workspace_id, period, metric), metric is always
// 'image_storage_bytes', and workspace_id is bound at $1 (in-code scoping; the
// variant Lambda runs as the service role and bypasses RLS).

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('monthBucket', () => {
  it('returns the first day of the month (UTC) for the date', () => {
    expect(monthBucket(new Date('2026-06-07T23:30:00Z'))).toBe('2026-06-01');
    expect(monthBucket(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
    expect(monthBucket(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-01');
  });
});

describe('buildImageBytesUpsert', () => {
  it('binds workspace_id at $1', () => {
    const stmt = buildImageBytesUpsert(WS, '2026-06-01', 1234);
    expect(stmt.values[0]).toBe(WS);
  });

  it('uses metric image_storage_bytes', () => {
    const stmt = buildImageBytesUpsert(WS, '2026-06-01', 1234);
    expect(stmt.values).toContain('image_storage_bytes');
  });

  it('passes the byte count as the value', () => {
    const stmt = buildImageBytesUpsert(WS, '2026-06-01', 4096);
    expect(stmt.values).toContain(4096);
  });

  it('is additive: ON CONFLICT DO UPDATE value = value + EXCLUDED.value', () => {
    const stmt = buildImageBytesUpsert(WS, '2026-06-01', 1);
    const sql = stmt.text.replace(/\s+/g, ' ');
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, period, metric\)/i);
    expect(sql).toMatch(/value = usage_counters\.value \+ EXCLUDED\.value/i);
  });

  it('requires a workspaceId (tenant-isolation guard)', () => {
    expect(() => buildImageBytesUpsert('', '2026-06-01', 1)).toThrow();
  });
});
