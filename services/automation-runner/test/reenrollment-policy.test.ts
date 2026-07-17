// Phase 3: the re-enrollment policy is enforced consistently across all three
// trigger kinds — decideReenrollment is the SINGLE decision point and
// buildEnrollmentInsert always emits the structural ON CONFLICT 'once' guard.
import { describe, it, expect } from 'vitest';
import { decideReenrollment, buildEnrollmentInsert, DEFAULT_REENROLLMENT_POLICY } from '../src/core.js';

describe('re-enrollment policy', () => {
  it("default 'once': enroll only when no existing row", () => {
    expect(decideReenrollment(false, 'once')).toBe(true);
    expect(decideReenrollment(true, 'once')).toBe(false);
  });

  it("'always' allows re-entry regardless of an existing row", () => {
    expect(decideReenrollment(true, 'always')).toBe(true);
    expect(decideReenrollment(false, 'always')).toBe(true);
  });

  it("the documented default policy is 'once' (shared by all three trigger kinds)", () => {
    expect(DEFAULT_REENROLLMENT_POLICY).toBe('once');
    // The default arg of decideReenrollment is 'once' too.
    expect(decideReenrollment(true)).toBe(false);
    expect(decideReenrollment(false)).toBe(true);
  });

  it('buildEnrollmentInsert ALWAYS emits ON CONFLICT (automation_id, profile_id) DO NOTHING — kind-agnostic', () => {
    const stmt = buildEnrollmentInsert('ws-1', 'camp-1', 'prof-1', 'start');
    expect(stmt.text).toMatch(/ON CONFLICT \(automation_id, profile_id\) DO NOTHING/);
    expect(stmt.values[0]).toBe('ws-1'); // workspace_id bound at $1
  });
});
