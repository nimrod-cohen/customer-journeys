import { describe, it, expect } from 'vitest';
import { diffMembership } from '../src/diff.js';
import { planProfileSegmentTransition } from '../src/evaluate.js';

const WS = 'bbbbbbbb-0000-0000-0000-000000000001';
const SEG = 'bbbbbbbb-0000-0000-0000-0000000000aa';

describe('diffMembership (enter-once / exit-once, deduped)', () => {
  it('entered = matched \\ current', () => {
    const { entered, exited } = diffMembership(['a', 'b'], ['b', 'c']);
    expect(entered).toEqual(['c']);
    expect(exited).toEqual(['a']);
  });

  it('a profile in both is unchanged (no churn)', () => {
    const { entered, exited } = diffMembership(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(entered).toEqual([]);
    expect(exited).toEqual([]);
  });

  it('dedupes duplicate ids on either side (enter-once / exit-once)', () => {
    const d = diffMembership(['a', 'a', 'b'], ['b', 'b', 'c', 'c']);
    expect(d.entered).toEqual(['c']); // only once despite duplicates
    expect(d.exited).toEqual(['a']); // only once despite duplicates
  });

  it('empty current → everything matched is an enter', () => {
    expect(diffMembership([], ['x', 'y'])).toEqual({ entered: ['x', 'y'], exited: [] });
  });

  it('empty matched → everything current is an exit', () => {
    expect(diffMembership(['x', 'y'], [])).toEqual({ entered: [], exited: ['x', 'y'] });
  });
});

describe('planProfileSegmentTransition (single profile, realtime)', () => {
  it('matches & not member → enter (insert membership + change_log)', () => {
    const r = planProfileSegmentTransition(WS, SEG, 'p1', true, false);
    expect(r.action).toBe('entered');
    expect(r.statements).toHaveLength(2);
    expect(r.statements[0]!.text).toMatch(/INSERT INTO segment_memberships/i);
    expect(r.statements[0]!.text).toMatch(/'evaluator'/);
    expect(r.statements[1]!.text).toMatch(/INSERT INTO segment_change_log/i);
    expect(r.statements[1]!.values).toContain('entered');
    for (const s of r.statements) expect(s.values[0]).toBe(WS);
  });

  it('not match & member → exit (delete evaluator membership + change_log)', () => {
    const r = planProfileSegmentTransition(WS, SEG, 'p1', false, true);
    expect(r.action).toBe('exited');
    expect(r.statements[0]!.text).toMatch(/DELETE FROM segment_memberships/i);
    expect(r.statements[0]!.text).toMatch(/source = 'evaluator'/);
    expect(r.statements[1]!.values).toContain('exited');
  });

  it('match & member → none (no churn, no statements)', () => {
    const r = planProfileSegmentTransition(WS, SEG, 'p1', true, true);
    expect(r.action).toBe('none');
    expect(r.statements).toEqual([]);
  });

  it('not match & not member → none', () => {
    const r = planProfileSegmentTransition(WS, SEG, 'p1', false, false);
    expect(r.action).toBe('none');
    expect(r.statements).toEqual([]);
  });
});
