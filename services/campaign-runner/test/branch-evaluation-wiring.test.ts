import { describe, it, expect } from 'vitest';
import { buildBranchMatchQuery, evaluateBranch } from '../src/core.js';
import type { ConditionNode } from '../src/dsl.js';
import type { AstNode } from '@cdp/segments';

// §9B branch conditions reuse the §8 compiler (buildSegmentMatch): workspace_id
// is structurally $1 and the profile filter is appended as the next param.
describe('buildBranchMatchQuery', () => {
  const ast: AstNode = { field: 'attributes.country', operator: '=', value: 'IL' };

  it('binds workspace_id at $1 and the profile id last (AND p.id = $n)', () => {
    const q = buildBranchMatchQuery('ws-1', ast, 'prof-9');
    expect(q.values[0]).toBe('ws-1');
    expect(q.values[q.values.length - 1]).toBe('prof-9');
    expect(q.text).toMatch(/p\.workspace_id = \$1/);
    expect(q.text).toMatch(/AND p\.id = \$\d+/);
    // fully parameterized — the literal value never appears in the SQL text
    expect(q.text).not.toContain('IL');
  });

  it('throws on a falsy workspaceId', () => {
    expect(() => buildBranchMatchQuery('', ast, 'p')).toThrow(/workspaceId is required/);
  });
});

describe('evaluateBranch', () => {
  const node: ConditionNode = {
    type: 'condition',
    ast: { field: 'total_events', operator: '>', value: 0 },
    onTrue: 'A',
    onFalse: 'B',
  };
  it('routes onTrue/onFalse', () => {
    expect(evaluateBranch(node, true)).toBe('A');
    expect(evaluateBranch(node, false)).toBe('B');
  });
});
