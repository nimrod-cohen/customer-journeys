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

/** A rule-AST node — a boolean group, a leaf condition, or an event predicate. */
export type AstNode = GroupNode | ConditionNode | EventNode;

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
 * `in`/`not in` bind the WHOLE array as ONE param via `= ANY($n)` / `!= ALL($n)`.
 * `exists` takes no value and renders `IS NOT NULL`.
 */
export type OperatorToken = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'exists';

interface OperatorSpec {
  /** Whether the operator consumes a value (exists does not). */
  readonly takesValue: boolean;
  /** Whether the value is an array bound as a single param (in / not in). */
  readonly arrayParam: boolean;
}

export const OPERATORS: Readonly<Record<OperatorToken, OperatorSpec>> = {
  '=': { takesValue: true, arrayParam: false },
  '!=': { takesValue: true, arrayParam: false },
  '>': { takesValue: true, arrayParam: false },
  '>=': { takesValue: true, arrayParam: false },
  '<': { takesValue: true, arrayParam: false },
  '<=': { takesValue: true, arrayParam: false },
  in: { takesValue: true, arrayParam: true },
  'not in': { takesValue: true, arrayParam: true },
  exists: { takesValue: false, arrayParam: false },
};

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
  // Leaf condition.
  const cond = node as ConditionNode;
  if (typeof cond.field !== 'string' || cond.field.length === 0) {
    throw new Error('validateAst: condition.field must be a non-empty string');
  }
  if (typeof cond.operator !== 'string' || cond.operator.length === 0) {
    throw new Error('validateAst: condition.operator must be a non-empty string');
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
  if (op === 'exists') {
    return `${col} IS NOT NULL`;
  }
  if (!spec.takesValue) {
    // Defensive: only `exists` is valueless and handled above.
    throw new Error(`compileWhere: operator "${op}" has no value handler`);
  }
  if (spec.arrayParam) {
    if (!Array.isArray(value)) {
      throw new Error(`compileWhere: operator "${op}" requires an array value`);
    }
    // Bind the WHOLE array as ONE param.
    const arrParam = params.bind(value);
    if (op === 'in') return `${col} = ANY(${arrParam})`;
    return `${col} != ALL(${arrParam})`;
  }
  // Scalar comparison: value is bound as a single $n placeholder.
  const valParam = params.bind(value);
  return `${col} ${op} ${valParam}`;
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
  if (node.withinDays !== undefined) {
    if (typeof node.withinDays !== 'number' || !Number.isFinite(node.withinDays) || node.withinDays <= 0) {
      throw new Error('compileWhere: event.withinDays must be a positive number of days');
    }
    const daysParam = params.bind(node.withinDays);
    preds.push(`e.occurred_at >= now() - (${daysParam}::numeric * interval '1 day')`);
  }
  const subWhere = preds.join(' AND ');
  let predicate: string;
  if (node.operator !== undefined) {
    if (!EVENT_COUNT_OPERATORS.has(node.operator)) {
      throw new Error(`compileWhere: invalid event count operator "${node.operator}"`);
    }
    if (typeof node.value !== 'number' || Number.isNaN(node.value)) {
      throw new Error('compileWhere: event count value must be a number');
    }
    const valParam = params.bind(node.value);
    predicate = `(SELECT count(*) FROM events e WHERE ${subWhere}) ${node.operator} ${valParam}`;
  } else {
    // No count test → "occurred at least once".
    predicate = `EXISTS (SELECT 1 FROM events e WHERE ${subWhere})`;
  }
  // negate → "did NOT occur" (NOT EXISTS) / NOT(count op N).
  return node.negate ? `NOT (${predicate})` : predicate;
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
  return compileCondition(node as ConditionNode, params);
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
