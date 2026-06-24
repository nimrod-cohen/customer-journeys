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

/** The operators the builder UI exposes (matches the §8 compiler whitelist).
 *  Order is the display order inside each group. */
export const BUILDER_OPERATORS = [
  // Cross-type
  '=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'between', 'exists', 'not exists',
  // String (case-insensitive)
  'contains', 'not contains', 'starts with', 'ends with',
  // Timestamp
  'is in the past', 'is in the future',
  'before duration ago', 'in the last duration', 'within next duration',
  'after date', 'before date',
] as const;
export type BuilderOperator = (typeof BUILDER_OPERATORS)[number];

/** Semantic group for the comparator picker UI. */
export type OperatorGroup = 'common' | 'string' | 'timestamp';

/** Whitelist of duration units accepted by the duration-based timestamp ops. */
export const DURATION_UNITS = ['days', 'hours', 'minutes'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/** What kind of input widget the value column should render for an operator. */
export type ValueShape = 'text' | 'number' | 'duration' | 'date' | 'list' | 'pair' | 'none';

/** Per-operator UI metadata — drives the grouped dropdown + value-input shape. */
export interface OperatorMeta {
  readonly value: BuilderOperator;
  readonly label: string;
  readonly group: OperatorGroup;
  readonly groupLabel: string;
  readonly valueShape: ValueShape;
}

export const OPERATOR_CATALOG: readonly OperatorMeta[] = [
  // String or number
  { value: '=',           label: 'is equal to',     group: 'common', groupLabel: 'String or number', valueShape: 'text' },
  { value: '!=',          label: 'is not equal to', group: 'common', groupLabel: 'String or number', valueShape: 'text' },
  { value: '>',           label: 'is greater than', group: 'common', groupLabel: 'String or number', valueShape: 'number' },
  { value: '>=',          label: 'is at least',     group: 'common', groupLabel: 'String or number', valueShape: 'number' },
  { value: '<',           label: 'is less than',    group: 'common', groupLabel: 'String or number', valueShape: 'number' },
  { value: '<=',          label: 'is at most',      group: 'common', groupLabel: 'String or number', valueShape: 'number' },
  { value: 'between',     label: 'is between',      group: 'common', groupLabel: 'String or number', valueShape: 'pair' },
  { value: 'in',          label: 'is one of',       group: 'common', groupLabel: 'String or number', valueShape: 'list' },
  { value: 'not in',      label: 'is not one of',   group: 'common', groupLabel: 'String or number', valueShape: 'list' },
  { value: 'exists',      label: 'exists',          group: 'common', groupLabel: 'String or number', valueShape: 'none' },
  { value: 'not exists',  label: 'does not exist',  group: 'common', groupLabel: 'String or number', valueShape: 'none' },
  // String
  { value: 'contains',     label: 'contains',          group: 'string', groupLabel: 'String', valueShape: 'text' },
  { value: 'not contains', label: 'does not contain',  group: 'string', groupLabel: 'String', valueShape: 'text' },
  { value: 'starts with',  label: 'starts with',       group: 'string', groupLabel: 'String', valueShape: 'text' },
  { value: 'ends with',    label: 'ends with',         group: 'string', groupLabel: 'String', valueShape: 'text' },
  // Timestamp
  { value: 'is in the past',       label: 'is in the past',       group: 'timestamp', groupLabel: 'Timestamp', valueShape: 'none' },
  { value: 'is in the future',     label: 'is in the future',     group: 'timestamp', groupLabel: 'Timestamp', valueShape: 'none' },
  { value: 'before duration ago',  label: 'is before N ago',      group: 'timestamp', groupLabel: 'Timestamp', valueShape: 'duration' },
  { value: 'in the last duration', label: 'is in the last N',     group: 'timestamp', groupLabel: 'Timestamp', valueShape: 'duration' },
  { value: 'within next duration', label: 'is within the next N', group: 'timestamp', groupLabel: 'Timestamp', valueShape: 'duration' },
  { value: 'after date',           label: 'is after specific date',  group: 'timestamp', groupLabel: 'Timestamp', valueShape: 'date' },
  { value: 'before date',          label: 'is before specific date', group: 'timestamp', groupLabel: 'Timestamp', valueShape: 'date' },
];

/** Lookup map keyed by operator token. */
export const OPERATOR_META: Readonly<Record<BuilderOperator, OperatorMeta>> = Object.freeze(
  Object.fromEntries(OPERATOR_CATALOG.map((m) => [m.value, m])) as Record<BuilderOperator, OperatorMeta>,
);

/** Operator groups in display order, with their member operators. */
export const OPERATOR_GROUPS: ReadonlyArray<{ group: OperatorGroup; label: string; ops: readonly OperatorMeta[] }> = [
  { group: 'common',    label: 'String or number', ops: OPERATOR_CATALOG.filter((m) => m.group === 'common') },
  { group: 'string',    label: 'String',           ops: OPERATOR_CATALOG.filter((m) => m.group === 'string') },
  { group: 'timestamp', label: 'Timestamp',        ops: OPERATOR_CATALOG.filter((m) => m.group === 'timestamp') },
];

/**
 * A rule row's kind:
 *   - 'field'         → a profile attribute / scalar field / counter condition
 *   - 'event'         → "did event X" (count + time window + payload attrs)
 *   - 'segment'       → IS / IS NOT a member of a segment (CAMPAIGN IF only)
 *   - 'trigger_event' → the ENROLLING event's data — a payload-only filter, NO
 *                       occurrence/time test (CAMPAIGN IF, event-triggered only)
 */
export type RuleKind = 'field' | 'event' | 'segment' | 'trigger_event';

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
  /** Event payload sub-conditions (kind 'event') OR the trigger-event payload
   *  filter rows (kind 'trigger_event'). */
  readonly conditions?: readonly EventCondition[];
  /** Segment id (kind 'segment'). */
  readonly segmentId?: string;
  /** kind 'segment': true = "is NOT a member"; false/absent = "is a member". */
  readonly segmentNegate?: boolean;
  /** kind 'trigger_event': how the payload-filter rows combine (default 'all'). */
  readonly triggerMatch?: 'all' | 'any';
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

/** An AST segment-membership leaf (matches @cdp/segments SegmentNode). */
export interface SegmentNode {
  segment: string;
  negate?: boolean;
}

/** An AST trigger-event leaf (matches @cdp/segments TriggerEventNode). */
export interface TriggerEventNode {
  triggerEvent: true;
  filter?: AstNode;
}

export type AstNode = GroupNode | ConditionNode | EventNode | SegmentNode | TriggerEventNode;

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

/** A blank segment-membership rule (CAMPAIGN IF). */
export function emptySegmentRow(): RuleRow {
  return { kind: 'segment', field: '', operator: '=', value: '', segmentId: '', segmentNegate: false, conditions: [] };
}

/** A blank trigger-event rule (CAMPAIGN IF, payload-only filter). */
export function emptyTriggerEventRow(): RuleRow {
  return { kind: 'trigger_event', field: '', operator: '=', value: '', triggerMatch: 'all', conditions: [] };
}

/** Parse a row's raw value into the typed AST value per operator. */
export function parseValue(operator: BuilderOperator, raw: string): unknown {
  const meta = OPERATOR_META[operator];
  const shape = meta?.valueShape ?? 'text';
  if (shape === 'none') return undefined;
  if (shape === 'list') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (shape === 'pair') {
    // "min,max" — coerce each half numerically when possible.
    const [a = '', b = ''] = raw.split(',').map((s) => s.trim());
    const an = Number(a);
    const bn = Number(b);
    return [
      a !== '' && !Number.isNaN(an) ? an : a,
      b !== '' && !Number.isNaN(bn) ? bn : b,
    ];
  }
  if (shape === 'duration') {
    // Stored as "amount|unit", e.g. "7|days" or "30|minutes". Unit defaults to
    // days when missing or invalid (the UI's initial select picks 'days').
    const [amtRaw = '', unitRaw = 'days'] = raw.split('|');
    const amount = Number(amtRaw);
    const unit = (DURATION_UNITS as readonly string[]).includes(unitRaw) ? (unitRaw as DurationUnit) : 'days';
    return { amount: Number.isNaN(amount) ? 0 : amount, unit };
  }
  if (shape === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (shape === 'date') {
    // Pass through as-is; the compiler casts to timestamptz.
    return raw;
  }
  // text — fall back to numeric coercion when the whole string parses cleanly
  // (legacy behavior so equality with numeric attributes still type-matches).
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
  const shape = OPERATOR_META[row.operator]?.valueShape ?? 'text';
  if (shape === 'none') {
    return { field, operator: row.operator };
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

/** Build one segment-membership node from a segment row (null when no segment chosen). */
function rowToSegment(row: RuleRow): SegmentNode | null {
  const id = (row.segmentId ?? '').trim();
  if (!id) return null;
  return row.segmentNegate ? { segment: id, negate: true } : { segment: id };
}

/** Build a trigger-event node from a trigger-event row: a payload-only filter over
 *  the enrolling event's data (no occurrence/time). Empty filter = matches whenever
 *  a trigger event exists. */
function rowToTriggerEvent(row: RuleRow): TriggerEventNode {
  const conds = (row.conditions ?? [])
    .filter((c) => c.field.trim().length > 0)
    .map((c) => rowToCondition({ field: `payload.${c.field.trim()}`, operator: c.operator, value: c.value }));
  if (conds.length === 0) return { triggerEvent: true };
  if (conds.length === 1) return { triggerEvent: true, filter: conds[0]! };
  const op: 'and' | 'or' = row.triggerMatch === 'any' ? 'or' : 'and';
  return { triggerEvent: true, filter: { op, conditions: conds } };
}

/** Build one AST node from a row (null when the row is empty/invalid). */
function rowToNode(row: RuleRow): AstNode | null {
  if (row.kind === 'event') return rowToEvent(row);
  if (row.kind === 'segment') return rowToSegment(row);
  if (row.kind === 'trigger_event') return rowToTriggerEvent(row);
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
function isSegmentNode(n: AstNode): n is SegmentNode {
  return typeof (n as SegmentNode).segment === 'string';
}
function isTriggerEventNode(n: AstNode): n is TriggerEventNode {
  return (n as TriggerEventNode).triggerEvent === true;
}
/** A GROUP node (the only non-leaf): has a string `op` + a conditions array. */
function isGroupNode(n: AstNode): n is GroupNode {
  return typeof (n as GroupNode).op === 'string' && Array.isArray((n as GroupNode).conditions);
}

/** Stringify an AST condition value back into the row's raw input form. */
function valueToRaw(operator: string, value: unknown): string {
  if (operator === 'exists' || operator === 'not exists') return '';
  if (operator === 'is in the past' || operator === 'is in the future') return '';
  if (value === undefined || value === null) return '';
  // Duration value: {amount, unit} → "amount|unit"
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'amount' in value &&
    'unit' in value
  ) {
    const v = value as { amount: unknown; unit: unknown };
    return `${v.amount}|${v.unit}`;
  }
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

/** Turn one segment-membership node into an editable segment row. */
function segmentToRow(n: SegmentNode): RuleRow {
  return { kind: 'segment', field: '', operator: '=', value: '', segmentId: n.segment, segmentNegate: n.negate === true, conditions: [] };
}

/** Turn one payload condition (`payload.<key>` …) into an editable EventCondition. */
function payloadCondToEventCondition(c: ConditionNode): EventCondition {
  return {
    field: c.field.startsWith('payload.') ? c.field.slice('payload.'.length) : c.field,
    operator: asBuilderOp(c.operator),
    value: valueToRaw(c.operator, c.value),
  };
}

/** Turn one trigger-event node into an editable trigger-event row (payload filter). */
function triggerEventToRow(n: TriggerEventNode): RuleRow {
  const filter = n.filter;
  let triggerMatch: 'all' | 'any' = 'all';
  let conditions: EventCondition[] = [];
  if (filter) {
    if (isGroupNode(filter)) {
      triggerMatch = filter.op === 'or' ? 'any' : 'all';
      conditions = filter.conditions.filter(isCondition).map(payloadCondToEventCondition);
    } else if (isCondition(filter)) {
      conditions = [payloadCondToEventCondition(filter)];
    }
  }
  return { kind: 'trigger_event', field: '', operator: '=', value: '', triggerMatch, conditions };
}

function leafToRow(n: AstNode): RuleRow {
  if (isEvent(n)) return eventToRow(n);
  if (isSegmentNode(n)) return segmentToRow(n);
  if (isTriggerEventNode(n)) return triggerEventToRow(n);
  return conditionToRow(n as ConditionNode);
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
  if (!isGroupNode(ast)) return { rows: [leafToRow(ast)], combinator: 'and' };
  const combinator: Combinator = ast.op === 'or' ? 'or' : 'and';
  const leaves: AstNode[] = [];
  const collect = (n: AstNode): void => {
    if (isGroupNode(n)) n.conditions.forEach(collect);
    else leaves.push(n);
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
  if (!isGroupNode(ast)) return { combinator: 'and', rows: [leafToRow(ast)], groups: [] };
  const combinator: Combinator = ast.op === 'or' ? 'or' : 'and';
  const rows: RuleRow[] = [];
  const groups: RuleGroup[] = [];
  const leavesOf = (n: AstNode): AstNode[] => {
    const out: AstNode[] = [];
    const walk = (x: AstNode): void => {
      if (isGroupNode(x)) x.conditions.forEach(walk);
      else out.push(x);
    };
    walk(n);
    return out;
  };
  for (const c of ast.conditions) {
    if (isGroupNode(c)) {
      groups.push({
        combinator: c.op === 'or' ? 'or' : 'and',
        rows: leavesOf(c).map(leafToRow),
        groups: [],
      });
    } else {
      rows.push(leafToRow(c));
    }
  }
  return { combinator, rows, groups };
}
