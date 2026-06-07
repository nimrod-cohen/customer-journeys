// Pure helpers for the dynamic segment rule-AST builder UI (§12 SegmentBuilder).
// The UI manipulates a list of simple rows + a top-level boolean op and compiles
// them into the §8 AstNode shape the backend compiler expects. Keeping this pure
// makes the builder unit-testable and guarantees the emitted AST is valid.

/** The operators the builder UI exposes (a subset matching the §8 whitelist). */
export const BUILDER_OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'exists'] as const;
export type BuilderOperator = (typeof BUILDER_OPERATORS)[number];

/** One editable rule row in the builder. */
export interface RuleRow {
  readonly field: string;
  readonly operator: BuilderOperator;
  /** Raw string value from the input; parsed per operator on build. */
  readonly value: string;
}

/** The top-level combinator. */
export type Combinator = 'and' | 'or';

/** An AST condition leaf (matches @cdp/segments ConditionNode). */
export interface ConditionNode {
  field: string;
  operator: string;
  value?: unknown;
}

/** An AST group node (matches @cdp/segments GroupNode). */
export interface GroupNode {
  op: 'and' | 'or' | 'not';
  conditions: AstNode[];
}

export type AstNode = GroupNode | ConditionNode;

/** A blank rule row for a fresh builder. */
export function emptyRow(): RuleRow {
  return { field: 'attributes.tier', operator: '=', value: '' };
}

/** Parse a row's raw value into the typed AST value per operator. */
export function parseValue(operator: BuilderOperator, raw: string): unknown {
  if (operator === 'exists') return undefined;
  if (operator === 'in' || operator === 'not in') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  // Numeric coercion when the whole string is a number; else keep as string.
  const n = Number(raw);
  if (raw.trim() !== '' && !Number.isNaN(n)) return n;
  return raw;
}

/** Build one condition node from a row. */
export function rowToCondition(row: RuleRow): ConditionNode {
  if (row.operator === 'exists') {
    return { field: row.field, operator: 'exists' };
  }
  return { field: row.field, operator: row.operator, value: parseValue(row.operator, row.value) };
}

/**
 * Build a §8 AST from the builder rows + combinator. An empty row list returns
 * null (matches everyone in the workspace). A single row returns the bare
 * condition (no needless group). Multiple rows wrap in an and/or group.
 */
export function buildAst(rows: readonly RuleRow[], combinator: Combinator): AstNode | null {
  const valid = rows.filter((r) => r.field.trim().length > 0);
  if (valid.length === 0) return null;
  const conditions = valid.map(rowToCondition);
  if (conditions.length === 1) return conditions[0]!;
  return { op: combinator, conditions };
}
