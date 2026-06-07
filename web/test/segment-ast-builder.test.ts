// The dynamic segment builder compiles editable rows into a §8 AST. We assert the
// emitted shape (single row → bare condition; multiple → and/or group), value
// parsing per operator, and that the result validates against the REAL backend
// compiler (compileWhere) — proving the UI emits exactly what the server accepts.
import { describe, it, expect } from 'vitest';
import { buildAst, parseValue, rowsFromAst, type RuleRow } from '../src/segments/ast-builder.js';
import { compileWhere } from '@cdp/segments';

const WS = '00000000-0000-4000-8000-000000000001';

describe('segment AST builder', () => {
  it('parses values per operator (number, csv array, exists→undefined)', () => {
    expect(parseValue('=', '5')).toBe(5);
    expect(parseValue('=', 'gold')).toBe('gold');
    expect(parseValue('in', 'a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(parseValue('exists', '')).toBeUndefined();
  });

  it('an empty row set builds null (match-all)', () => {
    expect(buildAst([], 'and')).toBeNull();
  });

  it('a single row builds a bare condition (no needless group)', () => {
    const rows: RuleRow[] = [{ field: 'attributes.tier', operator: '=', value: 'vip' }];
    expect(buildAst(rows, 'and')).toEqual({
      field: 'attributes.tier',
      operator: '=',
      value: 'vip',
    });
  });

  it('multiple rows wrap in the chosen combinator group', () => {
    const rows: RuleRow[] = [
      { field: 'attributes.tier', operator: '=', value: 'vip' },
      { field: 'total_events', operator: '>=', value: '3' },
    ];
    const ast = buildAst(rows, 'or');
    expect(ast).toEqual({
      op: 'or',
      conditions: [
        { field: 'attributes.tier', operator: '=', value: 'vip' },
        { field: 'total_events', operator: '>=', value: 3 },
      ],
    });
  });

  it('the emitted AST compiles cleanly through the REAL backend compiler', () => {
    const rows: RuleRow[] = [
      { field: 'attributes.tier', operator: '=', value: 'vip' },
      { field: 'total_events', operator: '>=', value: '3' },
    ];
    const ast = buildAst(rows, 'and');
    const sql = compileWhere(WS, ast as never);
    // workspace_id is ALWAYS structurally $1 (the compiler's guarantee).
    expect(sql.values[0]).toBe(WS);
    expect(sql.text).toContain('p.workspace_id = $1');
    // No literal value is concatenated — only placeholders.
    expect(sql.text).not.toContain('vip');
  });

  it('rowsFromAst reverses buildAst (load an existing segment into the editor)', () => {
    // null definition (manual / match-all) → one blank starter row.
    expect(rowsFromAst(null).rows.length).toBe(1);

    // A single bare condition round-trips to one row.
    const single = rowsFromAst({ field: 'attributes.tier', operator: '=', value: 'vip' });
    expect(single.combinator).toBe('and');
    expect(single.rows).toEqual([{ field: 'attributes.tier', operator: '=', value: 'vip' }]);

    // A group round-trips back to the same AST through buildAst (stable).
    const rows: RuleRow[] = [
      { field: 'attributes.tier', operator: '=', value: 'vip' },
      { field: 'total_events', operator: '>=', value: '3' },
    ];
    const ast = buildAst(rows, 'or');
    const back = rowsFromAst(ast);
    expect(back.combinator).toBe('or');
    expect(buildAst(back.rows, back.combinator)).toEqual(ast);

    // 'in' arrays stringify back to a comma list the input understands.
    const inAst = buildAst([{ field: 'attributes.tier', operator: 'in', value: 'a, b' }], 'and');
    expect(rowsFromAst(inAst).rows[0]!.value).toBe('a, b');
  });

  it('an exists row compiles to a value-less predicate', () => {
    const rows: RuleRow[] = [{ field: 'attributes.tier', operator: 'exists', value: '' }];
    const ast = buildAst(rows, 'and');
    expect(ast).toEqual({ field: 'attributes.tier', operator: 'exists' });
    const sql = compileWhere(WS, ast as never);
    expect(sql.text).toContain('IS NOT NULL');
  });
});
