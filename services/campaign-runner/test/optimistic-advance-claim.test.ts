import { describe, it, expect } from 'vitest';
import {
  buildSweepQuery,
  buildEnrollmentClaim,
  buildAdvanceEnrollment,
  buildEnrollmentInsert,
} from '../src/core.js';

const NOW = new Date('2026-06-07T12:00:00.000Z');

describe('buildSweepQuery', () => {
  it("selects active enrollments due now (status='active' AND next_run_at <= now)", () => {
    const q = buildSweepQuery(NOW);
    expect(q.text).toMatch(/status = 'active'/);
    expect(q.text).toMatch(/next_run_at <= \$1/);
    expect(q.values[0]).toBe(NOW.toISOString());
  });
});

describe('buildEnrollmentClaim (CAS on updated_at)', () => {
  it('guards on workspace_id, id, status=active and exact updated_at', () => {
    const q = buildEnrollmentClaim('ws', 'e1', NOW);
    expect(q.values).toEqual(['ws', 'e1', NOW.toISOString()]);
    expect(q.text).toMatch(/workspace_id = \$1/);
    expect(q.text).toMatch(/status = 'active'/);
    expect(q.text).toMatch(/updated_at::text = \$3/);
    expect(q.text).toMatch(/RETURNING/);
  });
  it('throws on falsy workspaceId', () => {
    expect(() => buildEnrollmentClaim('', 'e', NOW)).toThrow(/workspaceId is required/);
  });
});

describe('buildAdvanceEnrollment (guarded)', () => {
  it('updates node/status/next_run_at guarded by updated_at', () => {
    const q = buildAdvanceEnrollment('ws', 'e1', NOW, {
      currentNode: 'x',
      status: 'completed',
      nextRunAt: null,
    });
    expect(q.values[0]).toBe('ws');
    expect(q.values[3]).toBe('x');
    expect(q.values[4]).toBe('completed');
    expect(q.values[5]).toBe(null);
    expect(q.text).toMatch(/updated_at::text = \$3/);
  });
  it('serializes nextRunAt to ISO when present', () => {
    const q = buildAdvanceEnrollment('ws', 'e1', NOW, {
      currentNode: 'w',
      status: 'active',
      nextRunAt: new Date('2026-06-08T00:00:00.000Z'),
    });
    expect(q.values[5]).toBe('2026-06-08T00:00:00.000Z');
  });
});

describe('buildEnrollmentInsert', () => {
  it('is ON CONFLICT (campaign_id, profile_id) DO NOTHING with workspace_id at $1', () => {
    const q = buildEnrollmentInsert('ws', 'c1', 'p1', 'start');
    expect(q.values).toEqual(['ws', 'c1', 'p1', 'start']);
    expect(q.text).toMatch(/ON CONFLICT \(campaign_id, profile_id\) DO NOTHING/);
  });
  it('throws on falsy workspaceId', () => {
    expect(() => buildEnrollmentInsert('', 'c', 'p', 's')).toThrow();
  });
});
