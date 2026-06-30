// Pure tests for the campaign-IF rule kinds added to the shared builder: SEGMENT
// membership and TRIGGER-EVENT (payload-only). The emitted AST must match the
// @cdp/segments shapes (SegmentNode / TriggerEventNode) and round-trip back into
// editable rows.
import { describe, it, expect } from 'vitest';
import {
  buildAstFromGroup,
  groupHasCriteria,
  emptyRow,
  groupFromAst,
  emptySegmentRow,
  emptyTriggerEventRow,
  emptyJourneyRow,
  parseValue,
  rowToCondition,
  OPERATOR_CATALOG,
  OPERATOR_GROUPS,
  OPERATOR_META,
  type RuleGroup,
  type SegmentNode,
  type TriggerEventNode,
  type AstNode,
} from './ast-builder.js';

const groupOf = (rows: RuleGroup['rows']): RuleGroup => ({ combinator: 'and', rows, groups: [] });

describe('groupHasCriteria (active filter / audience detection)', () => {
  it('the STARTER row (default field, empty value) is NOT configured', () => {
    // emptyRow() pre-fills field=attributes.tier but value='' → buildAstFromGroup is
    // non-null (tier='') yet the filter must read as EMPTY (match-all).
    expect(buildAstFromGroup(groupOf([emptyRow()]))).not.toBeNull();
    expect(groupHasCriteria(groupOf([emptyRow()]))).toBe(false);
  });
  it('a field row WITH a value is configured', () => {
    expect(groupHasCriteria(groupOf([{ ...emptyRow(), value: 'vip' }]))).toBe(true);
  });
  it('a value-less operator (exists / not exists) is configured with no value', () => {
    expect(groupHasCriteria(groupOf([{ ...emptyRow(), operator: 'exists', value: '' }]))).toBe(true);
    expect(groupHasCriteria(groupOf([{ ...emptyRow(), operator: 'not exists', value: '' }]))).toBe(true);
  });
  it('a segment row counts only once a segment is chosen', () => {
    expect(groupHasCriteria(groupOf([emptySegmentRow()]))).toBe(false);
    expect(groupHasCriteria(groupOf([{ ...emptySegmentRow(), segmentId: 'seg-1' }]))).toBe(true);
  });
  it('a configured rule inside a SUB-GROUP counts', () => {
    const g: RuleGroup = { combinator: 'and', rows: [emptyRow()], groups: [groupOf([{ ...emptyRow(), value: 'gold' }])] };
    expect(groupHasCriteria(g)).toBe(true);
  });
  it('an all-empty group is not configured', () => {
    expect(groupHasCriteria(groupOf([emptyRow(), emptyRow()]))).toBe(false);
  });
});

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

describe('typed operator catalog', () => {
  it('every catalog entry is keyed in OPERATOR_META and belongs to exactly one group', () => {
    for (const m of OPERATOR_CATALOG) {
      expect(OPERATOR_META[m.value]).toBe(m);
      expect(OPERATOR_GROUPS.find((g) => g.group === m.group)?.ops.includes(m)).toBe(true);
    }
  });

  it('parseValue("between", "5,20") → numeric pair [5, 20]', () => {
    expect(parseValue('between', '5,20')).toEqual([5, 20]);
  });

  it('parseValue("contains", "Gold") keeps the string as-is (no numeric coercion)', () => {
    expect(parseValue('contains', 'Gold')).toBe('Gold');
  });

  it('parseValue("before duration ago", "30|days") → {amount, unit}', () => {
    expect(parseValue('before duration ago', '30|days')).toEqual({ amount: 30, unit: 'days' });
  });

  it('parseValue("before duration ago", "45|minutes") → minutes unit', () => {
    expect(parseValue('before duration ago', '45|minutes')).toEqual({ amount: 45, unit: 'minutes' });
  });

  it('parseValue("is in the past", anything) → undefined (no value)', () => {
    expect(parseValue('is in the past', '')).toBeUndefined();
  });

  it('parseValue("before duration ago", "7|bogus") → defaults unit to days', () => {
    expect(parseValue('before duration ago', '7|bogus')).toEqual({ amount: 7, unit: 'days' });
  });

  it('parseValue("after date", "2026-01-01") → kept as ISO string', () => {
    expect(parseValue('after date', '2026-01-01')).toBe('2026-01-01');
  });

  it('rowToCondition for "not exists" drops the value entirely', () => {
    expect(rowToCondition({ field: 'attributes.tier', operator: 'not exists', value: '' })).toEqual({
      field: 'attributes.tier',
      operator: 'not exists',
    });
  });

  it('rowToCondition for "contains" emits the operator with the raw string value', () => {
    expect(rowToCondition({ field: 'email', operator: 'contains', value: 'gmail' })).toEqual({
      field: 'email',
      operator: 'contains',
      value: 'gmail',
    });
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

describe('journey-attribute rule', () => {
  it('builds a JourneyNode (key in field) and round-trips back to a journey row', () => {
    const g = groupOf([{ ...emptyJourneyRow(), field: 'day', operator: '=' as const, value: 'saturday' }]);
    const ast = buildAstFromGroup(g);
    expect(ast).toEqual({ journeyKey: 'day', operator: '=', value: 'saturday' });
    const back = groupFromAst(ast as never);
    expect(back.rows[0]!.kind).toBe('journey');
    expect(back.rows[0]!.field).toBe('day');
    expect(back.rows[0]!.value).toBe('saturday');
  });
  it('a valueless operator (exists) omits the value', () => {
    const g = groupOf([{ ...emptyJourneyRow(), field: 'cohort', operator: 'exists' as const, value: '' }]);
    expect(buildAstFromGroup(g)).toEqual({ journeyKey: 'cohort', operator: 'exists' });
  });
  it('an empty journey key yields no node', () => {
    expect(buildAstFromGroup(groupOf([{ ...emptyJourneyRow(), field: '' }]))).toBeNull();
  });
});
