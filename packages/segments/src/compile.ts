// Segment rule-AST → parameterized SQL WHERE compiler (§8, CLAUDE.md invariant 6).
//
// SECURITY-CRITICAL. This is the single highest-value unit-test target. The
// compiler:
//   - ALWAYS prepends `workspace_id = $1` — structurally, NOT derived from the
//     AST. workspace_id is bound as values[0] for every compiled query, even an
//     empty AST.
//   - WHITELISTS fields and operators. Unknown field/operator THROWS — never
//     interpolated.
//   - Emits PARAMETERIZED SQL only. Every AST `value` becomes a `$n` placeholder;
//     no literal value is ever concatenated into the text.
//   - Binds jsonb KEY names as params too (closes the field-name injection
//     vector): `attributes.country` → `(p.attributes ->> $2)` where the key
//     `'country'` rides in values, never in the SQL string.
//
// The compiled WHERE targets `profiles p JOIN profile_features pf` (the caller
// supplies that FROM/JOIN; this module produces only the WHERE body + values).
//
// A field may also use the `customer.*` namespace (the same shorthand as email
// merge tags, §11): `customer.tier` ≡ `attributes.tier`, `customer.email` ≡ the
// scalar `email`. It's normalized to the canonical name BEFORE whitelisting, so
// the security guarantees below are unchanged.

import { resolveCustomerField } from '@cdp/shared';

/** A parameterized query fragment ready for `pool.query(text, values)`. */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/** A leaf predicate in the rule AST (§8). */
export interface ConditionNode {
  readonly field: string;
  readonly operator: string;
  readonly value?: unknown;
}

/** A boolean group node: `and` / `or` over conditions, or `not` (negation). */
export interface GroupNode {
  readonly op: 'and' | 'or' | 'not';
  readonly conditions: readonly AstNode[];
}

/**
 * An EVENT predicate leaf (§7/§8): "the profile has events of `event` type".
 * Compiles to a workspace-scoped subquery over `events e` keyed to `p.id`:
 *   - no `operator` → `EXISTS (… e.type = $)` (occurred at least once),
 *   - with `operator`+`value` → `(SELECT count(*) …) <op> $value` (count test),
 *   - optional `where` → payload predicates (`payload.<key>`) ANDed into the
 *     subquery (lets you match "had a purchase WHERE payload.amount = 100").
 *   - optional `withinDays` → restricts to events whose `occurred_at` is within
 *     the last N days (`e.occurred_at >= now() - $n*interval'1 day'`). This makes
 *     membership TIME-DEPENDENT: a profile drifts out of the segment as the window
 *     slides, with no new event — so such rules must be re-evaluated over time.
 *   - optional `negate` → wraps the whole predicate in `NOT (…)`. negate + no
 *     operator = "did NOT occur" (NOT EXISTS), the dual of "occurred".
 * workspace_id is bound at $1 INSIDE the subquery too — never another tenant.
 */
export interface EventNode {
  readonly event: string;
  readonly operator?: '>' | '>=' | '=' | '<=' | '<';
  readonly value?: number;
  readonly where?: readonly ConditionNode[];
  /** Restrict to events in the last N days (positive integer). Omitted = ever. */
  readonly withinDays?: number;
  /** Negate the whole event predicate (NOT EXISTS / NOT(count op N)). */
  readonly negate?: boolean;
}

/**
 * A SEGMENT-MEMBERSHIP leaf (§8): "the profile IS (or, with `negate`, is NOT) a
 * member of segment `segment`". Compiles to an EXISTS over `segment_memberships`
 * (workspace_id bound at $1, profile keyed to `p.id`, segment id a bound param).
 */
export interface SegmentNode {
  readonly segment: string; // segment id (uuid)
  readonly negate?: boolean; // true → "is NOT a member"
}

/**
 * A CONSTANT leaf — `TRUE`/`FALSE`. The automation runner pre-evaluates a leaf it
 * CANNOT express in SQL (a trigger-event condition) in-memory and folds the
 * boolean result into the AST as a ConstNode before compiling.
 */
export interface ConstNode {
  readonly const: boolean;
}

/**
 * A TRIGGER-EVENT leaf (AUTOMATION IF only): match the ENROLLING event's payload.
 * It is NOT SQL-compilable (the trigger event lives on `automation_enrollments.state`,
 * not a table the segment SQL touches) — the automation runner evaluates `filter`
 * in-memory against the persisted trigger event and REWRITES this node to a
 * ConstNode BEFORE compiling. `filter` is a `payload.*` AstNode (the same closed
 * grammar as the event TRIGGER's payload filter); omitted = matches whenever a
 * trigger event exists. Reaching the SQL compiler with one of these is a bug.
 */
export interface TriggerEventNode {
  readonly triggerEvent: true;
  readonly filter?: AstNode;
}

/**
 * A JOURNEY-attribute leaf (AUTOMATION IF only): match a per-enrollment journey
 * VARIABLE (set by an Update-journey node, stored on `automation_enrollments.state.journey`).
 * Like a trigger-event leaf it is NOT SQL-compilable (journey vars live on the
 * enrollment row, not a table the segment SQL touches) — the automation runner
 * evaluates it in-memory against `state.journey` and REWRITES this node to a
 * ConstNode BEFORE compiling. `journeyKey` is the variable key (deep-dot supported,
 * e.g. `cohort` or `meta.tier`). Reaching the SQL compiler with one is a bug.
 */
export interface JourneyNode {
  readonly journeyKey: string;
  readonly operator: string;
  readonly value?: unknown;
}

/** A rule-AST node — a boolean group, a leaf condition, an event predicate, a
 *  segment-membership leaf, a constant, a (automation-only) trigger-event leaf, or a
 *  (automation-only) journey-attribute leaf. */
export type AstNode =
  | GroupNode
  | ConditionNode
  | EventNode
  | SegmentNode
  | ConstNode
  | TriggerEventNode
  | JourneyNode;

/** The count-comparison operators an EventNode may use. */
const EVENT_COUNT_OPERATORS = new Set(['>', '>=', '=', '<=', '<']);
/** The jsonb prefix for event payload fields inside an EventNode.where. */
const PAYLOAD_PREFIX = 'payload.';

/** How a whitelisted field maps to a SQL column expression. */
type FieldKind =
  | { readonly kind: 'attribute' } // profiles.attributes ->> <key>
  | { readonly kind: 'counter' } // (profile_features.counters ->> <key>)::numeric
  | { readonly kind: 'scalar'; readonly column: string }; // a scalar profile_features column

/**
 * The scalar feature columns a segment rule may reference directly (§6/§8).
 * Anything not here (or not an `attributes.*` / `features.counters.*` prefix) is
 * rejected by `resolveField`. Mapped to a fully-qualified, never-interpolated
 * column reference on `profile_features pf`.
 */
export const SCALAR_FEATURE_FIELDS: Readonly<Record<string, string>> = {
  total_events: 'pf.total_events',
  monetary_total: 'pf.monetary_total',
  last_event_at: 'pf.last_event_at',
  last_email_open_at: 'pf.last_email_open_at',
};

/**
 * Scalar columns on `profiles` a rule may reference directly (§6/§8). Notably
 * `email_status` — so "unsubscribers" is `email_status = unsubscribed` (a profile
 * column), NOT an attribute. Mapped to a fixed, never-interpolated `p.<col>`.
 */
export const SCALAR_PROFILE_FIELDS: Readonly<Record<string, string>> = {
  email_status: 'p.email_status',
  email: 'p.email',
  external_id: 'p.external_id',
  created_at: 'p.created_at',
};

/** Prefix for profile attribute fields: `attributes.<key>` (jsonb ->> key). */
const ATTRIBUTE_PREFIX = 'attributes.';
/** Prefix for feature counter fields: `features.counters.<key>` (jsonb ->> key, numeric). */
const COUNTER_PREFIX = 'features.counters.';

/**
 * The whitelisted operators (§8). Maps the AST operator token to how it renders.
 * Grouped by the value type each one implies, so the UI can present a typed
 * comparator picker:
 *   - "common": works for both strings and numbers (=, !=, >, >=, <, <=, in,
 *     not in, between, exists, not exists)
 *   - "string": case-insensitive substring/prefix/suffix (contains, not
 *     contains, starts with, ends with)
 *   - "timestamp": time-aware comparisons against a clock (before duration
 *     ago, after duration from now, within next duration, is in the past, is
 *     in the future, after date, before date). Duration ops take a {amount,
 *     unit} value where unit
 *     is one of 'days' | 'hours' | 'minutes'. Works against both scalar
 *     timestamptz columns AND text-jsonb values that hold ISO strings or unix
 *     seconds/millis — see `tsExpr` for the coercion CASE.
 */
export type OperatorToken =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'in'
  | 'not in'
  | 'between'
  | 'exists'
  | 'not exists'
  // string ops (case-insensitive)
  | 'contains'
  | 'not contains'
  | 'starts with'
  | 'ends with'
  // timestamp ops
  | 'before duration ago'
  | 'after duration from now'
  | 'in the last duration'
  | 'within next duration'
  | 'is in the past'
  | 'is in the future'
  | 'after date'
  | 'before date';

export type OperatorGroup = 'common' | 'string' | 'timestamp';

interface OperatorSpec {
  /** Whether the operator consumes a value (exists/not exists do not). */
  readonly takesValue: boolean;
  /** Whether the value is an array bound as a single param (in / not in). */
  readonly arrayParam: boolean;
  /** Whether the value is a 2-tuple [min,max] (between). */
  readonly pairValue?: boolean;
  /** Semantic group — used by the UI to render an optgroup'd picker. */
  readonly group: OperatorGroup;
}

export const OPERATORS: Readonly<Record<OperatorToken, OperatorSpec>> = {
  '=': { takesValue: true, arrayParam: false, group: 'common' },
  '!=': { takesValue: true, arrayParam: false, group: 'common' },
  '>': { takesValue: true, arrayParam: false, group: 'common' },
  '>=': { takesValue: true, arrayParam: false, group: 'common' },
  '<': { takesValue: true, arrayParam: false, group: 'common' },
  '<=': { takesValue: true, arrayParam: false, group: 'common' },
  in: { takesValue: true, arrayParam: true, group: 'common' },
  'not in': { takesValue: true, arrayParam: true, group: 'common' },
  between: { takesValue: true, arrayParam: false, pairValue: true, group: 'common' },
  exists: { takesValue: false, arrayParam: false, group: 'common' },
  'not exists': { takesValue: false, arrayParam: false, group: 'common' },
  // String — case-insensitive (ILIKE)
  contains: { takesValue: true, arrayParam: false, group: 'string' },
  'not contains': { takesValue: true, arrayParam: false, group: 'string' },
  'starts with': { takesValue: true, arrayParam: false, group: 'string' },
  'ends with': { takesValue: true, arrayParam: false, group: 'string' },
  // Timestamp
  'before duration ago': { takesValue: true, arrayParam: false, group: 'timestamp' },
  'after duration from now': { takesValue: true, arrayParam: false, group: 'timestamp' },
  'in the last duration': { takesValue: true, arrayParam: false, group: 'timestamp' },
  'within next duration': { takesValue: true, arrayParam: false, group: 'timestamp' },
  'is in the past': { takesValue: false, arrayParam: false, group: 'timestamp' },
  'is in the future': { takesValue: false, arrayParam: false, group: 'timestamp' },
  'after date': { takesValue: true, arrayParam: false, group: 'timestamp' },
  'before date': { takesValue: true, arrayParam: false, group: 'timestamp' },
};

/** Allowed duration units for the timestamp-duration ops. Whitelisted because
 *  the unit becomes part of the SQL interval text (never bound as a param). */
export type DurationUnit = 'days' | 'hours' | 'minutes';
const DURATION_INTERVAL: Readonly<Record<DurationUnit, string>> = {
  days: `interval '1 day'`,
  hours: `interval '1 hour'`,
  minutes: `interval '1 minute'`,
};
function parseDurationValue(value: unknown): { amount: number; unit: DurationUnit } {
  // Accepts either {amount, unit} (the canonical shape) or a bare number
  // (legacy/back-compat — defaults to days).
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { amount: value, unit: 'days' };
  }
  if (
    value &&
    typeof value === 'object' &&
    'amount' in value &&
    'unit' in value &&
    typeof (value as { amount: unknown }).amount === 'number' &&
    Number.isFinite((value as { amount: number }).amount)
  ) {
    const v = value as { amount: number; unit: unknown };
    if (v.unit === 'days' || v.unit === 'hours' || v.unit === 'minutes') {
      return { amount: v.amount, unit: v.unit };
    }
  }
  throw new Error('compileWhere: duration value must be { amount: number, unit: days|hours|minutes }');
}

/** Scalar profile/feature columns that are already PostgreSQL timestamptz.
 *  Used by `tsExpr` to skip the text-coercion CASE for these. */
const KNOWN_TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set([
  'p.created_at',
  'pf.last_event_at',
  'pf.last_email_open_at',
]);

/** A resolved field: the column expression plus an optional jsonb key to bind. */
export interface ResolvedField {
  /** How this field maps to SQL. */
  readonly mapping: FieldKind;
  /** The jsonb key to bind as a param (for attribute/counter fields); else null. */
  readonly jsonKey: string | null;
}

function isGroup(node: AstNode): node is GroupNode {
  return (
    typeof (node as GroupNode).op === 'string' &&
    Array.isArray((node as GroupNode).conditions)
  );
}

function isEvent(node: AstNode): node is EventNode {
  return typeof (node as EventNode).event === 'string';
}

function isSegment(node: AstNode): node is SegmentNode {
  return typeof (node as SegmentNode).segment === 'string';
}

function isConst(node: AstNode): node is ConstNode {
  return typeof (node as ConstNode).const === 'boolean';
}

function isTriggerEvent(node: AstNode): node is TriggerEventNode {
  return (node as TriggerEventNode).triggerEvent === true;
}

/** A journey-attribute leaf (automation IF, evaluated in-memory + rewritten before SQL). */
export function isJourney(node: AstNode): node is JourneyNode {
  return typeof (node as JourneyNode).journeyKey === 'string';
}

/**
 * Resolve an AST field name against the whitelist. THROWS on anything unknown —
 * this is the field-name injection guard. For `attributes.*` and
 * `features.counters.*` the jsonb key is captured to be BOUND as a param (never
 * concatenated into SQL).
 */
export function resolveField(rawField: string): ResolvedField {
  if (typeof rawField !== 'string' || rawField.length === 0) {
    throw new Error('compileWhere: field must be a non-empty string');
  }
  // Normalize the `customer.*` namespace + shorthand to the canonical field name
  // (`customer.tier` → `attributes.tier`, `customer.email` → `email`) before the
  // whitelist runs. A bare `customer.` stays as-is and is rejected below.
  const field = resolveCustomerField(rawField);
  if (Object.prototype.hasOwnProperty.call(SCALAR_FEATURE_FIELDS, field)) {
    const column = SCALAR_FEATURE_FIELDS[field] as string;
    return { mapping: { kind: 'scalar', column }, jsonKey: null };
  }
  if (Object.prototype.hasOwnProperty.call(SCALAR_PROFILE_FIELDS, field)) {
    const column = SCALAR_PROFILE_FIELDS[field] as string;
    return { mapping: { kind: 'scalar', column }, jsonKey: null };
  }
  if (field.startsWith(COUNTER_PREFIX)) {
    const key = field.slice(COUNTER_PREFIX.length);
    if (key.length === 0) throw new Error(`compileWhere: empty counter key in field "${field}"`);
    return { mapping: { kind: 'counter' }, jsonKey: key };
  }
  if (field.startsWith(ATTRIBUTE_PREFIX)) {
    const key = field.slice(ATTRIBUTE_PREFIX.length);
    if (key.length === 0) throw new Error(`compileWhere: empty attribute key in field "${field}"`);
    return { mapping: { kind: 'attribute' }, jsonKey: key };
  }
  throw new Error(`compileWhere: field "${field}" is not whitelisted`);
}

/** Resolve an AST operator against the whitelist. THROWS on unknown operators. */
export function resolveOperator(operator: string): OperatorToken {
  if (Object.prototype.hasOwnProperty.call(OPERATORS, operator)) {
    return operator as OperatorToken;
  }
  throw new Error(`compileWhere: operator "${operator}" is not whitelisted`);
}

/**
 * Structurally validate an AST (shape only — field/operator whitelisting happens
 * in `resolveField`/`resolveOperator` during compilation). THROWS on a malformed
 * shape so we never compile garbage.
 */
export function validateAst(node: AstNode): void {
  if (node === null || typeof node !== 'object') {
    throw new Error('validateAst: node must be an object');
  }
  if (isGroup(node)) {
    if (node.op !== 'and' && node.op !== 'or' && node.op !== 'not') {
      throw new Error(`validateAst: unknown group op "${(node as GroupNode).op}"`);
    }
    if (!Array.isArray(node.conditions) || node.conditions.length === 0) {
      throw new Error(`validateAst: group "${node.op}" needs a non-empty conditions array`);
    }
    if (node.op === 'not' && node.conditions.length !== 1) {
      throw new Error('validateAst: "not" must wrap exactly one condition');
    }
    for (const child of node.conditions) validateAst(child);
    return;
  }
  if (isEvent(node)) {
    if (typeof node.event !== 'string' || node.event.length === 0) {
      throw new Error('validateAst: event.event must be a non-empty string');
    }
    const hasOp = node.operator !== undefined;
    const hasVal = node.value !== undefined;
    if (hasOp !== hasVal) {
      throw new Error('validateAst: event operator and value must be set together');
    }
    if (hasOp) {
      if (!EVENT_COUNT_OPERATORS.has(node.operator as string)) {
        throw new Error(`validateAst: invalid event count operator "${node.operator}"`);
      }
      if (typeof node.value !== 'number' || Number.isNaN(node.value)) {
        throw new Error('validateAst: event count value must be a number');
      }
    }
    if (node.where !== undefined) {
      if (!Array.isArray(node.where)) {
        throw new Error('validateAst: event.where must be an array');
      }
      for (const w of node.where) {
        validateAst(w);
        if (typeof w.field !== 'string' || !w.field.startsWith(PAYLOAD_PREFIX)) {
          throw new Error(`validateAst: event.where field must start with "${PAYLOAD_PREFIX}"`);
        }
      }
    }
    if (node.withinDays !== undefined) {
      if (typeof node.withinDays !== 'number' || !Number.isFinite(node.withinDays) || node.withinDays <= 0) {
        throw new Error('validateAst: event.withinDays must be a positive number of days');
      }
    }
    if (node.negate !== undefined && typeof node.negate !== 'boolean') {
      throw new Error('validateAst: event.negate must be a boolean');
    }
    return;
  }
  if (isSegment(node)) {
    if (typeof node.segment !== 'string' || node.segment.length === 0) {
      throw new Error('validateAst: segment node needs a non-empty segment id');
    }
    if (node.negate !== undefined && typeof node.negate !== 'boolean') {
      throw new Error('validateAst: segment.negate must be a boolean');
    }
    return;
  }
  if (isConst(node)) {
    // `const` already type-narrowed to boolean by isConst — nothing more to check.
    return;
  }
  if (isTriggerEvent(node)) {
    // The filter (optional) is a payload.* AstNode — same closed grammar as the
    // event trigger; every leaf field MUST be a `payload.*` path.
    if (node.filter !== undefined) {
      assertPayloadOnlyAst(node.filter);
    }
    return;
  }
  if (isJourney(node)) {
    if (typeof node.journeyKey !== 'string' || node.journeyKey.length === 0) {
      throw new Error('validateAst: journey leaf needs a non-empty journeyKey');
    }
    resolveOperator(node.operator); // whitelist the operator (THROWS on unknown)
    return;
  }
  // Leaf condition.
  const cond = node as ConditionNode;
  if (typeof cond.field !== 'string' || cond.field.length === 0) {
    throw new Error('validateAst: condition.field must be a non-empty string');
  }
  if (typeof cond.operator !== 'string' || cond.operator.length === 0) {
    throw new Error('validateAst: condition.operator must be a non-empty string');
  }
}

/** Validate a payload-only AST (a trigger-event filter): groups over `payload.*`
 *  leaf conditions ONLY — no profile-field / event / segment / const leaves. */
function assertPayloadOnlyAst(node: AstNode): void {
  if (node === null || typeof node !== 'object') {
    throw new Error('validateAst: trigger-event filter must be an object');
  }
  if (isGroup(node)) {
    if (node.op !== 'and' && node.op !== 'or' && node.op !== 'not') {
      throw new Error(`validateAst: trigger-event filter unknown group op "${(node as GroupNode).op}"`);
    }
    if (!Array.isArray(node.conditions) || node.conditions.length === 0) {
      throw new Error('validateAst: trigger-event filter group needs a non-empty conditions array');
    }
    if (node.op === 'not' && node.conditions.length !== 1) {
      throw new Error('validateAst: trigger-event filter "not" wraps exactly one condition');
    }
    for (const c of node.conditions) assertPayloadOnlyAst(c);
    return;
  }
  const cond = node as ConditionNode;
  if (typeof cond.field !== 'string' || !cond.field.startsWith(PAYLOAD_PREFIX)) {
    throw new Error(`validateAst: trigger-event filter field must start with "${PAYLOAD_PREFIX}"`);
  }
  if (typeof cond.operator !== 'string' || cond.operator.length === 0) {
    throw new Error('validateAst: trigger-event filter condition.operator must be a non-empty string');
  }
}

/**
 * Whether a rule AST is TIME-SENSITIVE — i.e. contains any event predicate with a
 * `withinDays` window, so its membership changes purely as the clock moves (a
 * profile ages out with no new event). Such segments need periodic re-evaluation
 * (the scheduled sweep) to emit enter/exit transitions; non-time-sensitive ones
 * change only on data changes (handled by the realtime processor). Pure.
 */
export function isTimeSensitive(ast: AstNode | null | undefined): boolean {
  if (!ast) return false;
  if (isGroup(ast)) return ast.conditions.some((c) => isTimeSensitive(c));
  if (isEvent(ast)) return ast.withinDays !== undefined;
  return false;
}

/** Internal: a placeholder allocator that tracks the running param list. */
class ParamBuilder {
  // workspace_id is structurally $1; AST values start at $2.
  constructor(public readonly values: unknown[]) {}
  /** Bind a value and return its `$n` placeholder. */
  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Render the column expression for a resolved field, binding any jsonb key. */
function renderColumn(field: ResolvedField, params: ParamBuilder): string {
  switch (field.mapping.kind) {
    case 'scalar':
      return field.mapping.column;
    case 'attribute': {
      const keyParam = params.bind(field.jsonKey);
      return `(p.attributes ->> ${keyParam})`;
    }
    case 'counter': {
      const keyParam = params.bind(field.jsonKey);
      return `(pf.counters ->> ${keyParam})::numeric`;
    }
  }
}

/**
 * Coerce a column expression to a timestamptz for time-aware comparisons.
 * Scalar timestamptz columns (created_at, last_event_at, last_email_open_at)
 * pass through unchanged. Text-jsonb extractions get a CASE that recognizes
 * unix-millis (13 digits), unix-seconds (10 digits), or ISO strings — so a
 * payload key holding any of those formats compares correctly without the
 * admin having to pick a "type".
 */
function tsExpr(col: string): string {
  if (KNOWN_TIMESTAMP_COLUMNS.has(col)) return col;
  return `(CASE
    WHEN ${col} ~ '^[0-9]{13}$' THEN to_timestamp((${col})::bigint / 1000.0)
    WHEN ${col} ~ '^[0-9]{10}$' THEN to_timestamp((${col})::bigint)
    WHEN ${col} IS NOT NULL THEN (${col})::timestamptz
    ELSE NULL
  END)`;
}

/**
 * Render a parameterized predicate for an already-resolved column expression.
 * Shared by profile/feature conditions (`renderColumn`) and event-payload
 * conditions (`e.payload ->> $key`), so operator handling lives in ONE place.
 */
function compilePredicate(
  col: string,
  op: OperatorToken,
  value: unknown,
  params: ParamBuilder,
): string {
  const spec = OPERATORS[op];
  if (op === 'exists') return `${col} IS NOT NULL`;
  if (op === 'not exists') return `${col} IS NULL`;
  // Valueless timestamp ops — handled before the catch-all !takesValue guard.
  if (op === 'is in the past') return `${tsExpr(col)} < now()`;
  if (op === 'is in the future') return `${tsExpr(col)} > now()`;
  if (!spec.takesValue) {
    throw new Error(`compileWhere: operator "${op}" has no value handler`);
  }
  if (spec.arrayParam) {
    if (!Array.isArray(value)) {
      throw new Error(`compileWhere: operator "${op}" requires an array value`);
    }
    const arrParam = params.bind(value);
    if (op === 'in') return `${col} = ANY(${arrParam})`;
    return `${col} != ALL(${arrParam})`;
  }
  if (spec.pairValue) {
    // between: value is [min, max], bound as 2 params.
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error(`compileWhere: operator "${op}" requires a [min, max] tuple`);
    }
    const a = params.bind(value[0]);
    const b = params.bind(value[1]);
    return `${col} BETWEEN ${a} AND ${b}`;
  }
  // String ops — case-insensitive substring/prefix/suffix via ILIKE. Bind the
  // raw needle so % characters in user input are treated literally.
  if (op === 'contains' || op === 'not contains' || op === 'starts with' || op === 'ends with') {
    const needle = String(value ?? '');
    const pattern =
      op === 'contains' || op === 'not contains'
        ? `%${escapeLikePattern(needle)}%`
        : op === 'starts with'
          ? `${escapeLikePattern(needle)}%`
          : `%${escapeLikePattern(needle)}`;
    const p = params.bind(pattern);
    const negate = op === 'not contains';
    return `${col} ${negate ? 'NOT ILIKE' : 'ILIKE'} ${p}`;
  }
  // Timestamp ops — coerce the column to timestamptz first.
  if (op === 'before duration ago') {
    const { amount, unit } = parseDurationValue(value);
    const d = params.bind(amount);
    return `${tsExpr(col)} < now() - (${d}::numeric * ${DURATION_INTERVAL[unit]})`;
  }
  if (op === 'after duration from now') {
    // The FUTURE mirror of 'before duration ago': more than N units AHEAD of now
    // (e.g. "is more than 4 days from now"). Strictly beyond the window.
    const { amount, unit } = parseDurationValue(value);
    const d = params.bind(amount);
    return `${tsExpr(col)} > now() + (${d}::numeric * ${DURATION_INTERVAL[unit]})`;
  }
  if (op === 'in the last duration') {
    // Recent past: between (now - N) and now, exclusive of older, inclusive of now.
    const { amount, unit } = parseDurationValue(value);
    const d = params.bind(amount);
    const e = tsExpr(col);
    return `(${e} > now() - (${d}::numeric * ${DURATION_INTERVAL[unit]}) AND ${e} <= now())`;
  }
  if (op === 'within next duration') {
    const { amount, unit } = parseDurationValue(value);
    const d = params.bind(amount);
    return `${tsExpr(col)} BETWEEN now() AND now() + (${d}::numeric * ${DURATION_INTERVAL[unit]})`;
  }
  if (op === 'after date') {
    const p = params.bind(String(value));
    return `${tsExpr(col)} > ${p}::timestamptz`;
  }
  if (op === 'before date') {
    const p = params.bind(String(value));
    return `${tsExpr(col)} < ${p}::timestamptz`;
  }
  // Scalar comparison: value is bound as a single $n placeholder.
  const valParam = params.bind(value);
  return `${col} ${op} ${valParam}`;
}

/** Escape LIKE wildcards (% and _) so user input matches literally. */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Compile a single leaf condition (profile attribute / feature / scalar field). */
function compileCondition(cond: ConditionNode, params: ParamBuilder): string {
  const field = resolveField(cond.field);
  const op = resolveOperator(cond.operator);
  const col = renderColumn(field, params);
  return compilePredicate(col, op, cond.value, params);
}

/** Compile one event-payload condition (`payload.<key>` → `e.payload ->> $key`). */
function compilePayloadCondition(cond: ConditionNode, params: ParamBuilder): string {
  if (typeof cond.field !== 'string' || !cond.field.startsWith(PAYLOAD_PREFIX)) {
    throw new Error(`compileWhere: event payload field must start with "${PAYLOAD_PREFIX}"`);
  }
  const key = cond.field.slice(PAYLOAD_PREFIX.length);
  if (key.length === 0) throw new Error('compileWhere: empty payload key');
  const op = resolveOperator(cond.operator);
  const keyParam = params.bind(key);
  const col = `(e.payload ->> ${keyParam})`;
  return compilePredicate(col, op, cond.value, params);
}

/**
 * Compile an EVENT predicate into a workspace-scoped subquery over `events e`.
 * workspace_id is bound at $1 here too (the SAME structural guard), and the
 * event type / payload keys / values are ALL parameters — never interpolated.
 */
function compileEvent(node: EventNode, params: ParamBuilder): string {
  const typeParam = params.bind(node.event);
  const preds = [`e.workspace_id = $1`, `e.profile_id = p.id`, `e.type = ${typeParam}`];
  for (const w of node.where ?? []) {
    preds.push(compilePayloadCondition(w, params));
  }
  // Optional rolling time window: only events in the last N days count. The day
  // count is a bound param (never interpolated); now() makes it slide over time.
  let daysParam: string | null = null;
  if (node.withinDays !== undefined) {
    if (typeof node.withinDays !== 'number' || !Number.isFinite(node.withinDays) || node.withinDays <= 0) {
      throw new Error('compileWhere: event.withinDays must be a positive number of days');
    }
    daysParam = params.bind(node.withinDays);
    preds.push(`e.occurred_at >= now() - (${daysParam}::numeric * interval '1 day')`);
  }
  const subWhere = preds.join(' AND ');
  let predicate: string;
  // Whether a profile with ZERO matching events in the window would satisfy the
  // predicate (BEFORE negation). For absence-based rules this is true, and such
  // rules need the tenure guard below to avoid counting too-new profiles.
  let zeroSatisfies: boolean;
  if (node.operator !== undefined) {
    if (!EVENT_COUNT_OPERATORS.has(node.operator)) {
      throw new Error(`compileWhere: invalid event count operator "${node.operator}"`);
    }
    if (typeof node.value !== 'number' || Number.isNaN(node.value)) {
      throw new Error('compileWhere: event count value must be a number');
    }
    const valParam = params.bind(node.value);
    predicate = `(SELECT count(*) FROM events e WHERE ${subWhere}) ${node.operator} ${valParam}`;
    zeroSatisfies = countComparisonHoldsForZero(node.operator, node.value);
  } else {
    // No count test → "occurred at least once".
    predicate = `EXISTS (SELECT 1 FROM events e WHERE ${subWhere})`;
    zeroSatisfies = false; // EXISTS needs ≥1 event
  }
  // negate → "did NOT occur" (NOT EXISTS) / NOT(count op N).
  if (node.negate) {
    predicate = `NOT (${predicate})`;
    zeroSatisfies = !zeroSatisfies;
  }
  // Tenure guard (§ false-positive fix): an absence-based windowed rule — e.g.
  // "did NOT open within the last 90 days" — would otherwise match profiles too
  // new to have had the chance. Require the profile to have existed for the WHOLE
  // window before it can satisfy such a rule. Applies only when the window is set
  // AND zero in-window events satisfies the (possibly negated) predicate.
  if (daysParam !== null && zeroSatisfies) {
    predicate = `(${predicate}) AND p.created_at <= now() - (${daysParam}::numeric * interval '1 day')`;
  }
  return predicate;
}

/** Does `0 <op> value` hold? Used to detect absence-based count rules. */
function countComparisonHoldsForZero(op: string, value: number): boolean {
  switch (op) {
    case '>':
      return 0 > value;
    case '>=':
      return 0 >= value;
    case '=':
      return value === 0;
    case '<=':
      return 0 <= value;
    case '<':
      return 0 < value;
    default:
      return false;
  }
}

/** Compile any AST node (group / event / leaf) to a parameterized SQL boolean expression. */
function compileNode(node: AstNode, params: ParamBuilder): string {
  if (isGroup(node)) {
    if (node.op === 'not') {
      const inner = compileNode(node.conditions[0] as AstNode, params);
      return `NOT (${inner})`;
    }
    const joiner = node.op === 'and' ? ' AND ' : ' OR ';
    const parts = node.conditions.map((c) => compileNode(c, params));
    return `(${parts.join(joiner)})`;
  }
  if (isEvent(node)) {
    return compileEvent(node, params);
  }
  if (isSegment(node)) {
    return compileSegment(node, params);
  }
  if (isConst(node)) {
    return node.const ? 'TRUE' : 'FALSE';
  }
  if (isTriggerEvent(node)) {
    throw new Error(
      'compileWhere: a trigger-event leaf must be evaluated in-memory and rewritten to a constant before SQL compilation',
    );
  }
  if (isJourney(node)) {
    throw new Error(
      'compileWhere: a journey-attribute leaf must be evaluated in-memory and rewritten to a constant before SQL compilation',
    );
  }
  return compileCondition(node as ConditionNode, params);
}

/**
 * Compile a segment-membership leaf into an EXISTS over `segment_memberships`
 * (workspace_id bound at $1 — the SAME structural guard; profile keyed to `p.id`;
 * the segment id is a bound param, never interpolated). `negate` → NOT EXISTS.
 */
function compileSegment(node: SegmentNode, params: ParamBuilder): string {
  if (typeof node.segment !== 'string' || node.segment.length === 0) {
    throw new Error('compileWhere: segment node needs a segment id');
  }
  const idParam = params.bind(node.segment);
  const exists = `EXISTS (SELECT 1 FROM segment_memberships sm WHERE sm.workspace_id = $1 AND sm.profile_id = p.id AND sm.segment_id = ${idParam})`;
  return node.negate ? `NOT ${exists}` : exists;
}

/**
 * Compile a rule AST into a parameterized SQL WHERE body over `profiles p JOIN
 * profile_features pf`, with `workspace_id = $1` ALWAYS prepended (CLAUDE.md
 * invariant 6).
 *
 * workspace_id is structurally values[0] / `$1`, NEVER derived from the AST. An
 * empty / null AST still yields `p.workspace_id = $1 AND (TRUE)`. Every value in
 * the AST becomes a `$n` placeholder — no literal appears in `text`.
 *
 * @param workspaceId bound at $1 (mandatory; throws if falsy).
 * @param ast the rule AST (null/undefined → matches all in-workspace profiles).
 */
export function compileWhere(workspaceId: string, ast: AstNode | null | undefined): SqlStatement {
  if (!workspaceId) {
    throw new Error('compileWhere: workspaceId is required (tenant-isolation guard)');
  }
  // workspace_id is structurally $1.
  const params = new ParamBuilder([workspaceId]);
  let body: string;
  if (ast === null || ast === undefined) {
    body = 'TRUE';
  } else {
    validateAst(ast);
    body = compileNode(ast, params);
  }
  return {
    text: `p.workspace_id = $1 AND (${body})`,
    values: params.values,
  };
}
