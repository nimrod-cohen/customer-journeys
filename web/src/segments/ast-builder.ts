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

/**
 * The event occurrence test: 'occurred' = at least once (EXISTS), 'not_occurred'
 * = never/none (NOT EXISTS); the rest are count comparisons (count <op> n). All
 * are scoped by the row's time window (ever | within last N days).
 */
export const EVENT_COUNT_OPS = ['occurred', 'not_occurred', '>=', '>', '=', '<=', '<'] as const;
export type EventCountOp = (typeof EVENT_COUNT_OPS)[number];

/** Whether an event op is a numeric count comparison (needs an N value). */
export function isCountOp(op: EventCountOp): boolean {
  return op !== 'occurred' && op !== 'not_occurred';
}

/** The event time window: 'ever' (all time) or 'within' the last N days. */
export type EventWindow = 'ever' | 'within';

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
  /** Event occurrence/count operator (kind 'event'); 'occurred' = at least once. */
  readonly eventOp?: EventCountOp;
  /** Event time window (kind 'event'): 'ever' (default) or 'within' the last N days. */
  readonly eventWindow?: EventWindow;
  /** Number of days for an 'within' window (raw input string). */
  readonly eventWindowDays?: string;
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
  withinDays?: number;
  negate?: boolean;
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
  return {
    kind: 'event',
    field: 'purchase',
    operator: '=',
    value: '',
    eventOp: 'occurred',
    eventWindow: 'ever',
    eventWindowDays: '30',
    conditions: [],
  };
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

/**
 * Scalar profile/feature fields a rule can reference directly (mirrors the
 * @cdp/segments whitelist). A BARE key NOT in this set — and not already a dotted
 * path (attributes./customer./features.counters./payload.) — is taken as a
 * profile ATTRIBUTE, so a user can type "is_admin" and mean attributes.is_admin
 * (same intuition as the customer.<key> shorthand). The compiler still binds the
 * key as a parameter and stays strict about everything else.
 */
const SCALAR_FIELDS = new Set<string>([
  'email',
  'email_status',
  'external_id',
  'created_at',
  'total_events',
  'monetary_total',
  'last_event_at',
  'last_email_open_at',
]);

/** Normalize a builder field input to a path the compiler accepts. */
export function normalizeFieldPath(field: string): string {
  const f = field.trim();
  if (f === '' || f.includes('.')) return f; // already a path (attributes./customer./features.counters./payload.)
  return SCALAR_FIELDS.has(f) ? f : `attributes.${f}`;
}

/** Build one condition node from a field/payload row. */
export function rowToCondition(row: { field: string; operator: BuilderOperator; value: string }): ConditionNode {
  const field = normalizeFieldPath(row.field);
  if (row.operator === 'exists') {
    return { field, operator: 'exists' };
  }
  return { field, operator: row.operator, value: parseValue(row.operator, row.value) };
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
  // Time window: 'within' the last N days (a positive integer) scopes the events.
  if (row.eventWindow === 'within') {
    const days = Number(row.eventWindowDays);
    if (Number.isFinite(days) && days > 0) node.withinDays = days;
  }
  // Occurrence / count: 'occurred' = EXISTS, 'not_occurred' = NOT EXISTS, else count.
  const eventOp = row.eventOp ?? 'occurred';
  if (eventOp === 'not_occurred') {
    node.negate = true;
  } else if (isCountOp(eventOp)) {
    node.operator = eventOp as '>' | '>=' | '=' | '<=' | '<';
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

/**
 * A boolean GROUP in the builder: a combinator over leaf rules and (for the root)
 * nested sub-groups. The hierarchy is at most 2 levels — the root group may hold
 * sub-groups, but sub-groups hold only rules (no deeper nesting).
 */
export interface RuleGroup {
  combinator: Combinator;
  rows: RuleRow[];
  /** Nested sub-groups (root only; leaf groups keep this empty). */
  groups: RuleGroup[];
}

/** A fresh group with one blank field rule. */
export function emptyGroup(): RuleGroup {
  return { combinator: 'and', rows: [emptyRow()], groups: [] };
}

/**
 * Build a §8 AST from a (possibly nested) group. Empty → null. A single effective
 * node returns bare (no needless wrapper). Otherwise wraps children in the
 * group's and/or. Sub-groups compile recursively.
 */
export function buildAstFromGroup(group: RuleGroup): AstNode | null {
  const ruleNodes = group.rows.map(rowToNode).filter((n): n is AstNode => n !== null);
  const groupNodes = (group.groups ?? [])
    .map(buildAstFromGroup)
    .filter((n): n is AstNode => n !== null);
  const all = [...ruleNodes, ...groupNodes];
  if (all.length === 0) return null;
  if (all.length === 1) return all[0]!;
  return { op: group.combinator, conditions: all };
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
  const eventOp: EventCountOp = ev.operator ?? (ev.negate ? 'not_occurred' : 'occurred');
  return {
    kind: 'event',
    field: ev.event,
    operator: '=',
    value: ev.value !== undefined ? String(ev.value) : '',
    eventOp,
    eventWindow: ev.withinDays !== undefined ? 'within' : 'ever',
    eventWindowDays: ev.withinDays !== undefined ? String(ev.withinDays) : '30',
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

/**
 * Reverse of buildAstFromGroup: hydrate a stored §8 AST into the editable group
 * tree (root rules + sub-groups). A bare leaf → a root group with one rule. A
 * group node → its leaf conditions become root rules and its group conditions
 * become sub-groups (each holding that sub-group's leaves; any nesting deeper
 * than 2 levels is flattened into the sub-group's rules).
 */
export function groupFromAst(ast: AstNode | null | undefined): RuleGroup {
  if (!ast) return emptyGroup();
  if (isCondition(ast) || isEvent(ast)) return { combinator: 'and', rows: [leafToRow(ast)], groups: [] };
  const combinator: Combinator = ast.op === 'or' ? 'or' : 'and';
  const rows: RuleRow[] = [];
  const groups: RuleGroup[] = [];
  const leavesOf = (n: AstNode): AstNode[] => {
    const out: AstNode[] = [];
    const walk = (x: AstNode): void => {
      if (isCondition(x) || isEvent(x)) out.push(x);
      else x.conditions.forEach(walk);
    };
    walk(n);
    return out;
  };
  for (const c of ast.conditions) {
    if (isCondition(c) || isEvent(c)) {
      rows.push(leafToRow(c));
    } else {
      groups.push({
        combinator: c.op === 'or' ? 'or' : 'and',
        rows: leavesOf(c).map(leafToRow),
        groups: [],
      });
    }
  }
  return { combinator, rows, groups };
}
