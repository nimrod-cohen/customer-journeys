// Pure helpers for the dynamic segment rule-AST builder UI (§12 SegmentBuilder).
// The UI manipulates a list of typed rows + a top-level boolean op and compiles
// them into the §8 AstNode shape the backend compiler expects. Keeping this pure
// makes the builder unit-testable and guarantees the emitted AST is valid.
//
// A row is one of two KINDS (matching the editor's separation):
//   - 'field'  → a profile attribute / scalar field / counter condition
//                (e.g. attributes.tier = vip, email_status = unsubscribed).
//   - 'event'  → "did event X" with an optional count test and optional payload
//                ("event attribute") sub-conditions (e.g. did `lead` WHERE
//                payload.interest = strategies-webinar).

/** The operators the builder UI exposes (a subset matching the §8 whitelist). */
export const BUILDER_OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'exists'] as const;
export type BuilderOperator = (typeof BUILDER_OPERATORS)[number];

/** A rule row is a profile/attribute field test or an event test. */
export type RuleKind = 'field' | 'event';

/** The event count operators: 'occurred' = at least once (EXISTS); else count <op> n. */
export const EVENT_COUNT_OPS = ['occurred', '>=', '>', '=', '<=', '<'] as const;
export type EventCountOp = (typeof EVENT_COUNT_OPS)[number];

/** One payload ("event attribute") sub-condition within an event row. */
export interface EventCondition {
  /** The payload key (the builder prefixes `payload.`). */
  readonly field: string;
  readonly operator: BuilderOperator;
  readonly value: string;
}

/** One editable rule row in the builder. */
export interface RuleRow {
  /** Row kind (defaults to 'field' when omitted, for back-compat). */
  readonly kind?: RuleKind;
  /** field path (kind 'field') OR the event type name (kind 'event'). */
  readonly field: string;
  /** Comparison operator (kind 'field'). */
  readonly operator: BuilderOperator;
  /** Raw value: the field value (kind 'field') or the count value (kind 'event'). */
  readonly value: string;
  /** Event count operator (kind 'event'); 'occurred' = at least once. */
  readonly eventOp?: EventCountOp;
  /** Event payload sub-conditions (kind 'event'). */
  readonly conditions?: readonly EventCondition[];
}

/** The top-level combinator. */
export type Combinator = 'and' | 'or';

/** An AST condition leaf (matches @cdp/segments ConditionNode). */
export interface ConditionNode {
  field: string;
  operator: string;
  value?: unknown;
}

/** An AST event predicate (matches @cdp/segments EventNode). */
export interface EventNode {
  event: string;
  operator?: '>' | '>=' | '=' | '<=' | '<';
  value?: number;
  where?: ConditionNode[];
}

/** An AST group node (matches @cdp/segments GroupNode). */
export interface GroupNode {
  op: 'and' | 'or' | 'not';
  conditions: AstNode[];
}

export type AstNode = GroupNode | ConditionNode | EventNode;

/** A blank field rule for a fresh builder. */
export function emptyRow(): RuleRow {
  return { kind: 'field', field: 'attributes.tier', operator: '=', value: '', eventOp: 'occurred', conditions: [] };
}

/** A blank event rule. */
export function emptyEventRow(): RuleRow {
  return { kind: 'event', field: 'purchase', operator: '=', value: '', eventOp: 'occurred', conditions: [] };
}

/** A blank payload sub-condition. */
export function emptyEventCondition(): EventCondition {
  return { field: '', operator: '=', value: '' };
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

/** Build one condition node from a field/payload row. */
export function rowToCondition(row: { field: string; operator: BuilderOperator; value: string }): ConditionNode {
  if (row.operator === 'exists') {
    return { field: row.field, operator: 'exists' };
  }
  return { field: row.field, operator: row.operator, value: parseValue(row.operator, row.value) };
}

/** Build one event node from an event row. */
function rowToEvent(row: RuleRow): EventNode | null {
  const event = row.field.trim();
  if (!event) return null;
  const node: EventNode = { event };
  const conds = (row.conditions ?? [])
    .filter((c) => c.field.trim().length > 0)
    .map((c) => rowToCondition({ field: `payload.${c.field.trim()}`, operator: c.operator, value: c.value }));
  if (conds.length) node.where = conds;
  const eventOp = row.eventOp ?? 'occurred';
  if (eventOp !== 'occurred') {
    node.operator = eventOp;
    node.value = Number(row.value);
  }
  return node;
}

/** Build one AST node from a row (null when the row is empty/invalid). */
function rowToNode(row: RuleRow): AstNode | null {
  if (row.kind === 'event') return rowToEvent(row);
  if (row.field.trim().length === 0) return null;
  return rowToCondition(row);
}

/**
 * Build a §8 AST from the builder rows + combinator. An empty row list returns
 * null (matches everyone in the workspace). A single row returns the bare node
 * (no needless group). Multiple rows wrap in an and/or group.
 */
export function buildAst(rows: readonly RuleRow[], combinator: Combinator): AstNode | null {
  const nodes = rows.map(rowToNode).filter((n): n is AstNode => n !== null);
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0]!;
  return { op: combinator, conditions: nodes };
}

function isCondition(n: AstNode): n is ConditionNode {
  return (n as ConditionNode).field !== undefined;
}
function isEvent(n: AstNode): n is EventNode {
  return typeof (n as EventNode).event === 'string';
}

/** Stringify an AST condition value back into the row's raw input form. */
function valueToRaw(operator: string, value: unknown): string {
  if (operator === 'exists' || value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Coerce an arbitrary operator string to a known builder operator (fallback '='). */
function asBuilderOp(op: string): BuilderOperator {
  return (BUILDER_OPERATORS as readonly string[]).includes(op) ? (op as BuilderOperator) : '=';
}

/** Turn one condition node into an editable field row. */
function conditionToRow(c: ConditionNode): RuleRow {
  const operator = asBuilderOp(c.operator);
  return { kind: 'field', field: c.field, operator, value: valueToRaw(operator, c.value), eventOp: 'occurred', conditions: [] };
}

/** Turn one event node into an editable event row. */
function eventToRow(ev: EventNode): RuleRow {
  return {
    kind: 'event',
    field: ev.event,
    operator: '=',
    value: ev.value !== undefined ? String(ev.value) : '',
    eventOp: ev.operator ?? 'occurred',
    conditions: (ev.where ?? []).map((w) => ({
      field: w.field.startsWith('payload.') ? w.field.slice('payload.'.length) : w.field,
      operator: asBuilderOp(w.operator),
      value: valueToRaw(w.operator, w.value),
    })),
  };
}

function leafToRow(n: AstNode): RuleRow {
  return isEvent(n) ? eventToRow(n) : conditionToRow(n as ConditionNode);
}

/**
 * Reverse of buildAst: reconstruct the editable rows + combinator from a stored
 * §8 AST so an existing segment can be loaded into the builder. Best-effort for
 * the shapes the builder emits (a bare leaf, or one and/or group of leaves);
 * nested/`not` groups are flattened to their leaves.
 */
export function rowsFromAst(ast: AstNode | null | undefined): {
  rows: RuleRow[];
  combinator: Combinator;
} {
  if (!ast) return { rows: [emptyRow()], combinator: 'and' };
  if (isCondition(ast) || isEvent(ast)) return { rows: [leafToRow(ast)], combinator: 'and' };
  const combinator: Combinator = ast.op === 'or' ? 'or' : 'and';
  const leaves: AstNode[] = [];
  const collect = (n: AstNode): void => {
    if (isCondition(n) || isEvent(n)) leaves.push(n);
    else n.conditions.forEach(collect);
  };
  ast.conditions.forEach(collect);
  return {
    rows: leaves.length ? leaves.map(leafToRow) : [emptyRow()],
    combinator,
  };
}
