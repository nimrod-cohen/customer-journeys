// Pure tests for the campaign-IF rule kinds added to the shared builder: SEGMENT
// membership and TRIGGER-EVENT (payload-only). The emitted AST must match the
// @cdp/segments shapes (SegmentNode / TriggerEventNode) and round-trip back into
// editable rows.
import { describe, it, expect } from 'vitest';
import {
  buildAstFromGroup,
  groupFromAst,
  emptySegmentRow,
  emptyTriggerEventRow,
  type RuleGroup,
  type SegmentNode,
  type TriggerEventNode,
  type AstNode,
} from './ast-builder.js';

const groupOf = (rows: RuleGroup['rows']): RuleGroup => ({ combinator: 'and', rows, groups: [] });

describe('segment-membership row', () => {
  it('builds a SegmentNode ("is a member")', () => {
    const ast = buildAstFromGroup(groupOf([{ ...emptySegmentRow(), segmentId: 'seg-9' }]));
    expect(ast).toEqual({ segment: 'seg-9' });
  });
  it('builds a negated SegmentNode ("is NOT a member")', () => {
    const ast = buildAstFromGroup(groupOf([{ ...emptySegmentRow(), segmentId: 'seg-9', segmentNegate: true }]));
    expect(ast).toEqual({ segment: 'seg-9', negate: true });
  });
  it('a segment row with no chosen segment contributes nothing', () => {
    expect(buildAstFromGroup(groupOf([emptySegmentRow()]))).toBeNull();
  });
  it('round-trips a SegmentNode back into a segment row', () => {
    const g = groupFromAst({ segment: 'seg-9', negate: true } as SegmentNode);
    expect(g.rows[0]).toMatchObject({ kind: 'segment', segmentId: 'seg-9', segmentNegate: true });
  });
});

describe('trigger-event row (payload-only filter)', () => {
  it('no payload rows → matches whenever a trigger event exists', () => {
    expect(buildAstFromGroup(groupOf([emptyTriggerEventRow()]))).toEqual({ triggerEvent: true });
  });
  it('one payload row → a single payload.* condition filter', () => {
    const row = { ...emptyTriggerEventRow(), conditions: [{ field: 'amount', operator: '>=' as const, value: '100' }] };
    expect(buildAstFromGroup(groupOf([row]))).toEqual({
      triggerEvent: true,
      filter: { field: 'payload.amount', operator: '>=', value: 100 },
    });
  });
  it('multiple payload rows → a group (match all/any), payload.* prefixed', () => {
    const row = {
      ...emptyTriggerEventRow(),
      triggerMatch: 'any' as const,
      conditions: [
        { field: 'sku', operator: '=' as const, value: 'X1' },
        { field: 'amount', operator: '>' as const, value: '0' },
      ],
    };
    expect(buildAstFromGroup(groupOf([row]))).toEqual({
      triggerEvent: true,
      filter: {
        op: 'or',
        conditions: [
          { field: 'payload.sku', operator: '=', value: 'X1' },
          { field: 'payload.amount', operator: '>', value: 0 },
        ],
      },
    });
  });
  it('round-trips a grouped trigger-event filter back into payload rows', () => {
    const node: TriggerEventNode = {
      triggerEvent: true,
      filter: { op: 'or', conditions: [{ field: 'payload.sku', operator: '=', value: 'X1' }] } as AstNode,
    };
    const g = groupFromAst(node);
    expect(g.rows[0]).toMatchObject({ kind: 'trigger_event', triggerMatch: 'any' });
    expect(g.rows[0]!.conditions).toEqual([{ field: 'sku', operator: '=', value: 'X1' }]);
  });
});

describe('mixed kinds in one group still round-trip', () => {
  it('field + segment + trigger-event under AND', () => {
    const g = groupOf([
      { kind: 'field', field: 'attributes.tier', operator: '=', value: 'vip' },
      { ...emptySegmentRow(), segmentId: 'seg-1' },
      { ...emptyTriggerEventRow(), conditions: [{ field: 'amount', operator: '>=' as const, value: '10' }] },
    ]);
    const ast = buildAstFromGroup(g) as { op: string; conditions: unknown[] };
    expect(ast.op).toBe('and');
    expect(ast.conditions).toEqual([
      { field: 'attributes.tier', operator: '=', value: 'vip' },
      { segment: 'seg-1' },
      { triggerEvent: true, filter: { field: 'payload.amount', operator: '>=', value: 10 } },
    ]);
    // and back into 3 rows of the right kinds
    const back = groupFromAst(ast as never);
    expect(back.rows.map((r) => r.kind)).toEqual(['field', 'segment', 'trigger_event']);
  });
});
