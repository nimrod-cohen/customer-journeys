import { describe, it, expect } from 'vitest';
import { buildBranchMatchQuery, evaluateBranch, rewriteTriggerEventLeaves } from '../src/core.js';
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

// ── trigger-event leaf rewrite (in-memory) ──────────────────────────────────────
describe('rewriteTriggerEventLeaves', () => {
  it('folds a trigger-event leaf to const TRUE when the payload matches', () => {
    const ast: AstNode = { triggerEvent: true, filter: { field: 'payload.amount', operator: '>=', value: 100 } } as AstNode;
    const out = rewriteTriggerEventLeaves(ast, { amount: 250 });
    expect(out).toEqual({ const: true });
  });
  it('folds to const FALSE when the payload does NOT match', () => {
    const ast: AstNode = { triggerEvent: true, filter: { field: 'payload.amount', operator: '>=', value: 100 } } as AstNode;
    expect(rewriteTriggerEventLeaves(ast, { amount: 5 })).toEqual({ const: false });
  });
  it('folds to const FALSE when there is NO trigger event (manual/segment enroll)', () => {
    const ast: AstNode = { triggerEvent: true } as AstNode;
    expect(rewriteTriggerEventLeaves(ast, null)).toEqual({ const: false });
  });
  it('rewrites trigger-event leaves INSIDE a mixed group, leaving other leaves intact', () => {
    const ast: AstNode = {
      op: 'and',
      conditions: [
        { field: 'attributes.tier', operator: '=', value: 'vip' },
        { triggerEvent: true, filter: { field: 'payload.sku', operator: '=', value: 'X1' } },
        { segment: 'seg-1' },
      ],
    } as AstNode;
    const out = rewriteTriggerEventLeaves(ast, { sku: 'X1' }) as { op: string; conditions: AstNode[] };
    expect(out.op).toBe('and');
    expect(out.conditions[0]).toEqual({ field: 'attributes.tier', operator: '=', value: 'vip' });
    expect(out.conditions[1]).toEqual({ const: true });
    expect(out.conditions[2]).toEqual({ segment: 'seg-1' });
  });
  it('the rewritten AST is SQL-compilable (the const compiles; trigger leaf would have thrown)', () => {
    const ast: AstNode = { op: 'or', conditions: [{ triggerEvent: true } as AstNode, { field: 'attributes.tier', operator: '=', value: 'vip' }] } as AstNode;
    const rewritten = rewriteTriggerEventLeaves(ast, { x: 1 });
    expect(() => buildBranchMatchQuery('ws-1', rewritten, 'p-1')).not.toThrow();
  });
});
