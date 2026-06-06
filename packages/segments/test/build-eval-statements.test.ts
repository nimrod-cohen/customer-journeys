import { describe, it, expect } from 'vitest';
import {
  selectActiveRealtimeSegments,
  selectActiveBatchSegments,
  buildSegmentMatch,
  selectEvaluatorMembership,
  buildInsertMemberships,
  buildDeleteMemberships,
  buildChangeLog,
  buildResolveAudience,
} from '../src/statements.js';
import { addManualMembers, removeManualMembers, resolveAudience } from '../src/manual.js';
import type { AstNode } from '../src/compile.js';

const WS = 'cccccccc-0000-0000-0000-000000000001';
const SEG = 'cccccccc-0000-0000-0000-0000000000aa';
const PROFILE = 'cccccccc-0000-0000-0000-0000000000bb';

describe('segment selectors exclude manual + bind workspace_id $1', () => {
  it('selectActiveRealtimeSegments → only dynamic_realtime active', () => {
    const q = selectActiveRealtimeSegments(WS);
    expect(q.values).toEqual([WS]);
    expect(q.text).toMatch(/kind = 'dynamic_realtime'/);
    expect(q.text).toMatch(/status = 'active'/);
    expect(q.text).toMatch(/workspace_id = \$1/);
    expect(q.text).not.toMatch(/manual/);
  });

  it('selectActiveBatchSegments → only dynamic_batch active', () => {
    const q = selectActiveBatchSegments(WS);
    expect(q.values).toEqual([WS]);
    expect(q.text).toMatch(/kind = 'dynamic_batch'/);
    expect(q.text).not.toMatch(/manual/);
  });
});

describe('buildSegmentMatch reuses the §8 compiler', () => {
  const ast: AstNode = { field: 'total_events', operator: '>', value: 2 };

  it('workspace path: workspace_id $1, rule parameterized, no profile filter', () => {
    const q = buildSegmentMatch(WS, ast);
    expect(q.values).toEqual([WS, 2]);
    expect(q.text).toMatch(/FROM profiles p/);
    expect(q.text).toMatch(/LEFT JOIN profile_features pf/);
    expect(q.text).toMatch(/p\.workspace_id = \$1/);
    expect(q.text).not.toMatch(/p\.id = \$/);
  });

  it('realtime path: AND p.id = $n for the CHANGED profile', () => {
    const q = buildSegmentMatch(WS, ast, PROFILE);
    // workspace=$1, value=$2, profile=$3
    expect(q.values).toEqual([WS, 2, PROFILE]);
    expect(q.text).toMatch(/AND p\.id = \$3/);
  });

  it('null AST still scopes by workspace and matches all (TRUE)', () => {
    const q = buildSegmentMatch(WS, null, PROFILE);
    expect(q.values).toEqual([WS, PROFILE]);
    expect(q.text).toMatch(/p\.workspace_id = \$1 AND \(TRUE\)/);
    expect(q.text).toMatch(/AND p\.id = \$2/);
  });
});

describe('evaluator membership writes are source=evaluator and array-bound', () => {
  it('selectEvaluatorMembership filters source=evaluator', () => {
    const q = selectEvaluatorMembership(WS, SEG);
    expect(q.values).toEqual([WS, SEG]);
    expect(q.text).toMatch(/source = 'evaluator'/);
  });

  it('buildInsertMemberships forces source=evaluator, ON CONFLICT DO NOTHING, array param', () => {
    const q = buildInsertMemberships(WS, SEG, ['p1', 'p2']);
    expect(q.values).toEqual([WS, SEG, ['p1', 'p2']]);
    expect(q.text).toMatch(/'evaluator'/);
    expect(q.text).toMatch(/ON CONFLICT \(segment_id, profile_id\) DO NOTHING/i);
    expect(q.text).toMatch(/= ANY\(\$3::uuid\[\]\)/);
  });

  it('buildDeleteMemberships ONLY removes source=evaluator rows', () => {
    const q = buildDeleteMemberships(WS, SEG, ['p1']);
    expect(q.values).toEqual([WS, SEG, ['p1']]);
    expect(q.text).toMatch(/DELETE FROM segment_memberships/i);
    expect(q.text).toMatch(/source = 'evaluator'/);
    expect(q.text).toMatch(/= ANY\(\$3::uuid\[\]\)/);
  });

  it('buildChangeLog binds action + workspace $1', () => {
    const q = buildChangeLog(WS, SEG, ['p1', 'p2'], 'entered');
    expect(q.values).toEqual([WS, SEG, ['p1', 'p2'], 'entered']);
    expect(q.text).toMatch(/INSERT INTO segment_change_log/i);
  });
});

describe('manual membership owns source=manual; never touches evaluator rows', () => {
  it('addManualMembers writes source=manual', () => {
    const q = addManualMembers(WS, SEG, ['p1']);
    expect(q.values).toEqual([WS, SEG, ['p1']]);
    expect(q.text).toMatch(/'manual'/);
    expect(q.text).toMatch(/ON CONFLICT \(segment_id, profile_id\) DO NOTHING/i);
  });

  it('removeManualMembers ONLY removes source=manual rows', () => {
    const q = removeManualMembers(WS, SEG, ['p1']);
    expect(q.text).toMatch(/source = 'manual'/);
    expect(q.text).not.toMatch(/'evaluator'/);
  });
});

describe('audience resolution returns ALL members (both sources)', () => {
  it('buildResolveAudience does not filter by source', () => {
    const q = buildResolveAudience(WS, SEG);
    expect(q.values).toEqual([WS, SEG]);
    expect(q.text).not.toMatch(/source/);
    expect(q.text).toMatch(/workspace_id = \$1/);
  });

  it('resolveAudience (manual module) is the same audience query', () => {
    expect(resolveAudience(WS, SEG)).toEqual(buildResolveAudience(WS, SEG));
  });
});
