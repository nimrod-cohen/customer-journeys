// Per-node CONFIG read/write serialization for the campaign builder's editors
// (§9B phase 6). PURE — no I/O, no DOM. Each editor hydrates from a node via a
// read* helper and serializes its form back via a write* helper that returns a
// NEW DslNode (NON-edge fields only — edges live in the CanvasModel's edge list
// and are never touched here). applyNodeConfig patches one node in a CanvasModel
// immutably, preserving every edge slot. The IF editor binds to the SAME
// @cdp ast-builder used by SegmentBuilder (no second AST path), and the
// UPDATE-PROFILE editor uses the @cdp/shared ValueSpec. Unit-tested first.
import { validateAst, type AstNode as SegmentsAstNode } from '@cdp/segments';
import {
  isExpressionSpec,
  isLiteralSpec,
  isJsSpec,
  zonedInputToUtcIso,
  utcIsoToZonedInput,
  type ValueSpec,
} from '@cdp/shared';
import {
  buildAstFromGroup,
  groupFromAst,
  parseValue,
  BUILDER_OPERATORS,
  type AstNode,
  type ConditionNode,
  type GroupNode,
  type BuilderOperator,
  type RuleGroup,
} from '../segments/ast-builder.js';
import type { CanvasModel, CanvasNode, DslNode } from './model.js';

// ── model patching ──────────────────────────────────────────────────────────

/**
 * Immutably patch ONE node's NON-EDGE config in a CanvasModel. The node's raw
 * DSL is shallow-merged with `patch` (which must NOT carry next/onTrue/onFalse —
 * edges are authoritative in `model.edges`). The edge list is returned untouched,
 * so a re-`buildDefinition` keeps every target. Sibling nodes are not re-created.
 */
export function applyNodeConfig(model: CanvasModel, nodeId: string, patch: DslNode): CanvasModel {
  return {
    ...model,
    nodes: model.nodes.map((cn) =>
      cn.id === nodeId ? { id: cn.id, node: stripEdges({ ...cn.node, ...patch }) } : cn,
    ),
  };
}

/** Drop any edge slot a patch may have carried — edges live in the edge list. */
function stripEdges(node: DslNode): DslNode {
  const { next: _n, onTrue: _t, onFalse: _f, ...rest } = node as Record<string, unknown>;
  return rest as DslNode;
}

// ── TRIGGER ───────────────────────────────────────────────────────────────────

export type TriggerKind = 'segment_entry' | 'event' | 'profile' | 'manual';

/** Which profile mutation a kind='profile' trigger enrolls on. */
export type ProfileChange = 'created' | 'updated' | 'any';

export interface TriggerForm {
  readonly kind: TriggerKind;
  /** kind='event' (required at publish): the enrolling event type. */
  readonly eventType?: string;
  /** kind='event' (optional): a payload-only filter AstNode. */
  readonly filter?: AstNode;
  /** kind='profile' (optional): which mutation enrolls (default 'any'). */
  readonly profileChange?: ProfileChange;
  /** An OPTIONAL cosmetic name shown on the trigger card (like a condition's label). */
  readonly label?: string;
}

function asProfileChange(v: unknown): ProfileChange {
  return v === 'created' || v === 'updated' || v === 'any' ? v : 'any';
}

/** Read a trigger node into its editable form (segment id lives on the campaign row). */
export function readTriggerConfig(node: DslNode): TriggerForm {
  const n = node as { kind?: string; eventType?: string; filter?: AstNode; profileChange?: unknown; label?: unknown };
  const kind: TriggerKind =
    n.kind === 'event' || n.kind === 'manual' || n.kind === 'profile' || n.kind === 'segment_entry'
      ? n.kind
      : 'segment_entry';
  const label = typeof n.label === 'string' && n.label.trim() ? n.label.trim() : undefined;
  const base: TriggerForm = { kind, ...(label ? { label } : {}) };
  if (kind === 'event') {
    return { ...base, ...(n.eventType ? { eventType: n.eventType } : {}), ...(n.filter ? { filter: n.filter } : {}) };
  }
  if (kind === 'profile') {
    return { ...base, profileChange: asProfileChange(n.profileChange) };
  }
  return base;
}

/**
 * Serialize a trigger form to a node patch. The segment id for kind='segment_entry'
 * is a CAMPAIGN-ROW field (campaigns.trigger_segment_id) and is NEVER written into
 * the node. kind='event' carries eventType (+ optional payload filter); kind='profile'
 * carries profileChange (created|updated|any). A trimmed non-blank `label` (cosmetic
 * — never routing/validation) is carried for any kind.
 */
export function writeTriggerConfig(form: TriggerForm): DslNode {
  const label = (form.label ?? '').trim();
  const labelPart = label ? { label } : {};
  if (form.kind === 'event') {
    return {
      type: 'trigger',
      kind: 'event',
      eventType: (form.eventType ?? '').trim(),
      ...(form.filter ? { filter: form.filter } : {}),
      ...labelPart,
    };
  }
  if (form.kind === 'profile') {
    return { type: 'trigger', kind: 'profile', profileChange: asProfileChange(form.profileChange), ...labelPart };
  }
  return { type: 'trigger', kind: form.kind, ...labelPart };
}

// ── WAIT (relative duration) ───────────────────────────────────────────────────

/** Read a relative wait node's delay in whole seconds (0 when absent/absolute). */
export function readWaitSeconds(node: DslNode): number {
  const delay = (node as { delay?: { seconds?: number } | string }).delay;
  if (delay && typeof delay === 'object' && typeof delay.seconds === 'number') return delay.seconds;
  return 0;
}

/** Serialize a relative wait: a positive whole number of seconds (min 1). */
export function writeWaitConfig(seconds: number): DslNode {
  const secs = Number.isFinite(seconds) && seconds >= 1 ? Math.floor(seconds) : 1;
  return { type: 'wait', delay: { seconds: secs } };
}

// ── WAIT-UNTIL (rich: time gate + condition gate + max-wait cap) ────────────────

/** Read an absolute wait's instant back to a zoned wall-clock input (workspace tz). */
export function readWaitUntilInput(node: DslNode, timeZone: string): string {
  const until = (node as { until?: unknown }).until;
  if (typeof until !== 'string' || until.length === 0) return '';
  try {
    return utcIsoToZonedInput(until, timeZone);
  } catch {
    return '';
  }
}

/**
 * Serialize a SIMPLE wait-until: the zoned wall-clock input (interpreted in the
 * WORKSPACE timezone, DST-correct via zonedInputToUtcIso) → a stored UTC ISO instant.
 * (Kept for the date-only path / back-compat; the rich form below composes it.)
 */
export function writeWaitUntilConfig(localInput: string, timeZone: string): DslNode {
  return { type: 'wait', until: zonedInputToUtcIso(localInput, timeZone) };
}

export type WaitDurationUnit = 'minutes' | 'hours' | 'days';
const WAIT_UNITS = new Set<WaitDurationUnit>(['minutes', 'hours', 'days']);
const asWaitUnit = (u: unknown): WaitDurationUnit => (typeof u === 'string' && WAIT_UNITS.has(u as WaitDurationUnit) ? (u as WaitDurationUnit) : 'days');
const asAmount = (n: unknown, dflt = 1): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : dflt);

/**
 * The rich WAIT-UNTIL form. Any of the three gates may be enabled (combinable):
 *   - a TIME gate: `timeMode` 'date' (absolute datetime) | 'relative' (amount/unit
 *     from `now` or a {{timestamp}} expression) | 'none' (no time gate),
 *   - a CONDITION gate (segment-style rule group, reuses the RuleBuilder),
 *   - a MAX-WAIT cap (proceed-on-timeout).
 * At least one gate must be enabled to save (waitUntilFormHasGate).
 */
export interface WaitUntilForm {
  readonly timeMode: 'none' | 'date' | 'relative';
  readonly dateInput: string; // datetime-local (workspace-zoned) for timeMode 'date'
  readonly amount: number;
  readonly unit: WaitDurationUnit;
  readonly anchorKind: 'now' | 'expression';
  readonly anchorExpr: string; // {{...}} token expression when anchorKind 'expression'
  readonly hasCondition: boolean;
  readonly condition: RuleGroup;
  /** How the time + condition gates combine (only meaningful when both are on). */
  readonly combine: 'and' | 'or';
  readonly hasMaxWait: boolean;
  readonly maxAmount: number;
  readonly maxUnit: WaitDurationUnit;
}

/** Read a (possibly rich) wait node into the WAIT-UNTIL form. */
export function readWaitUntilForm(node: DslNode, timeZone: string): WaitUntilForm {
  const n = node as {
    until?: unknown;
    untilOffset?: { amount?: unknown; unit?: unknown; anchor?: unknown };
    waitCondition?: AstNode | null;
    combine?: unknown;
    maxWait?: { amount?: unknown; unit?: unknown };
  };
  let timeMode: WaitUntilForm['timeMode'] = 'none';
  let dateInput = '';
  let amount = 1;
  let unit: WaitDurationUnit = 'days';
  let anchorKind: 'now' | 'expression' = 'now';
  let anchorExpr = '';
  if (typeof n.until === 'string' && n.until.length > 0) {
    timeMode = 'date';
    dateInput = readWaitUntilInput(node, timeZone);
  } else if (n.untilOffset && typeof n.untilOffset === 'object') {
    timeMode = 'relative';
    amount = asAmount(n.untilOffset.amount);
    unit = asWaitUnit(n.untilOffset.unit);
    const anchor = n.untilOffset.anchor;
    if (typeof anchor === 'string' && anchor !== 'now') {
      anchorKind = 'expression';
      anchorExpr = anchor;
    }
  }
  const hasCondition = n.waitCondition !== undefined && n.waitCondition !== null;
  const condition = groupFromAst(hasCondition ? (n.waitCondition as AstNode) : null);
  const hasMaxWait = n.maxWait !== undefined && n.maxWait !== null;
  return {
    timeMode,
    dateInput,
    amount,
    unit,
    anchorKind,
    anchorExpr,
    hasCondition,
    condition,
    combine: n.combine === 'or' ? 'or' : 'and',
    hasMaxWait,
    maxAmount: hasMaxWait ? asAmount(n.maxWait!.amount) : 1,
    maxUnit: hasMaxWait ? asWaitUnit(n.maxWait!.unit) : 'days',
  };
}

/** True when the form enables at least one gate (a savable rich wait). */
export function waitUntilFormHasGate(form: WaitUntilForm): boolean {
  const timeOk = form.timeMode === 'date' ? form.dateInput.length > 0 : form.timeMode === 'relative';
  const condOk = form.hasCondition && !conditionGroupIsEmpty(form.condition);
  return timeOk || condOk || form.hasMaxWait;
}

/**
 * Serialize the WAIT-UNTIL form → a `{type:'wait', …}` node (edges reapplied by
 * applyNodeConfig). Returns null when no gate is enabled (the editor blocks save).
 */
export function writeWaitUntilForm(form: WaitUntilForm, timeZone: string): DslNode | null {
  if (!waitUntilFormHasGate(form)) return null;
  // applyNodeConfig MERGES the patch onto the existing node, so EVERY gate field is
  // emitted explicitly — `undefined` for a disabled gate so a previously-set value
  // (e.g. the default `until`) is cleared rather than lingering. (undefined keys are
  // dropped on the JSON round-trip; the read path treats them as absent.)
  let until: string | undefined;
  let untilOffset: { amount: number; unit: WaitDurationUnit; anchor: string } | undefined;
  if (form.timeMode === 'date' && form.dateInput.length > 0) {
    until = zonedInputToUtcIso(form.dateInput, timeZone);
  } else if (form.timeMode === 'relative') {
    const anchor = form.anchorKind === 'now' ? 'now' : form.anchorExpr.trim();
    if (anchor.length > 0) untilOffset = { amount: asAmount(form.amount), unit: form.unit, anchor };
  }
  const ast = form.hasCondition && !conditionGroupIsEmpty(form.condition) ? editorRowsToConditionAst(form.condition) : null;
  const maxWait = form.hasMaxWait ? { amount: asAmount(form.maxAmount), unit: form.maxUnit } : undefined;
  // `combine` only matters when BOTH a time gate and a condition gate are present.
  const hasTimeGate = until !== undefined || untilOffset !== undefined;
  const combine = hasTimeGate && ast ? form.combine : undefined;
  return {
    type: 'wait',
    delay: undefined,
    until,
    untilOffset,
    waitCondition: ast ?? undefined,
    combine,
    maxWait,
  } as unknown as DslNode;
}

// ── HOUR-OF-DAY WINDOW ──────────────────────────────────────────────────────────

export interface HourWindowForm {
  readonly startHour: number;
  readonly endHour: number;
  /** Allowed weekdays (0=Sun … 6=Sat); empty = all days. */
  readonly daysOfWeek: readonly number[];
}

/** Read an hour-window node into its editable form (no days → empty = all). */
export function readHourWindow(node: DslNode): HourWindowForm {
  const n = node as { startHour?: number; endHour?: number; daysOfWeek?: number[] };
  return {
    startHour: clampHour(n.startHour ?? 9),
    endHour: clampHour(n.endHour ?? 17),
    daysOfWeek: Array.isArray(n.daysOfWeek) ? [...n.daysOfWeek] : [],
  };
}

/**
 * Serialize an hour-window: integer startHour/endHour 0–23 (startHour>endHour is a
 * valid overnight window — preserved verbatim). daysOfWeek is written ONLY when a
 * non-empty UNIQUE subset is chosen (omitted = all days, per the DSL).
 */
export function writeHourWindowConfig(form: HourWindowForm): DslNode {
  const node: DslNode = {
    type: 'hour_of_day_window',
    startHour: clampHour(form.startHour),
    endHour: clampHour(form.endHour),
  };
  const days = [...new Set(form.daysOfWeek)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  if (days.length > 0) (node as { daysOfWeek?: number[] }).daysOfWeek = days;
  return node;
}

function clampHour(h: number): number {
  const n = Math.floor(Number(h));
  if (!Number.isFinite(n)) return 0;
  return Math.min(23, Math.max(0, n));
}

// ── IF / condition ───────────────────────────────────────────────────────────

/** Bind the IF editor to the SAME ast-builder helpers SegmentBuilder uses. */
export function editorRowsToConditionAst(group: RuleGroup): AstNode | null {
  return buildAstFromGroup(group);
}
export function conditionAstToRows(ast: AstNode | null | undefined): RuleGroup {
  return groupFromAst(ast);
}

/** Whether a builder group is empty (no effective rules) — the editor blocks save then. */
export function conditionGroupIsEmpty(group: RuleGroup): boolean {
  return buildAstFromGroup(group) === null;
}

/**
 * Serialize a condition: compile the builder group to the §8 AstNode (validated
 * via @cdp validateAst — the SAME AST the compiler whitelists). Returns null when
 * the group is empty (the editor must block save). Emits { type:'condition', ast }
 * (edges onTrue/onFalse stay in the edge list). An optional `label` (the branch's
 * human name) is included ONLY when non-blank — purely cosmetic, never routing.
 */
export function writeConditionConfig(group: RuleGroup, label?: string): DslNode | null {
  const ast = buildAstFromGroup(group);
  if (!ast) return null;
  validateAst(ast as unknown as SegmentsAstNode); // throws on a malformed shape (defensive; the builder emits valid §8 AST)
  const trimmed = (label ?? '').trim();
  return trimmed ? { type: 'condition', label: trimmed, ast } : { type: 'condition', ast };
}

// ── EVENT TRIGGER payload filter ─────────────────────────────────────────────
// The event trigger's optional "only when the event matches" filter is a
// PAYLOAD-ONLY narrowing: the event TYPE is already chosen, so this just adds
// `payload.<key> <op> <value>` conditions (match all/any). It is NOT the full
// segment rule builder (which also offers profile fields + "did event X" — both
// nonsensical here). The AST it emits is exactly what the runner's
// `evaluateEventPayloadFilter` consumes: a GroupNode (op and/or) of payload.*
// ConditionNodes. PURE + unit-tested.

export type EventFilterMatch = 'and' | 'or';
export interface EventFilterRow {
  /** The payload key WITHOUT the `payload.` prefix (the UI shows the bare key). */
  readonly field: string;
  readonly operator: BuilderOperator;
  readonly value: string;
}
export interface EventFilterForm {
  readonly match: EventFilterMatch;
  readonly rows: EventFilterRow[];
}

const PAYLOAD_PREFIX = 'payload.';

/** A blank payload-filter row for a fresh editor. */
export function emptyEventFilterRow(): EventFilterRow {
  return { field: '', operator: '=', value: '' };
}

function isGroupNode(n: AstNode): n is GroupNode {
  return typeof (n as GroupNode).op === 'string' && Array.isArray((n as GroupNode).conditions);
}
function isConditionNode(n: AstNode): n is ConditionNode {
  return typeof (n as ConditionNode).field === 'string';
}

function leafToRow(c: ConditionNode): EventFilterRow {
  const key = c.field.startsWith(PAYLOAD_PREFIX) ? c.field.slice(PAYLOAD_PREFIX.length) : c.field;
  const operator = (BUILDER_OPERATORS as readonly string[]).includes(c.operator)
    ? (c.operator as BuilderOperator)
    : '=';
  let value = '';
  if (Array.isArray(c.value)) value = (c.value as unknown[]).join(', ');
  else if (c.value !== undefined && c.value !== null) value = String(c.value);
  return { field: key, operator, value };
}

/**
 * Parse a stored event-payload filter AST back into the editor form. Accepts a
 * GroupNode (and/or) of payload.* leaves OR a bare leaf; anything else (or null)
 * yields one blank row so the editor always shows a starting row.
 */
export function readEventPayloadFilter(ast: AstNode | null | undefined): EventFilterForm {
  if (ast && isGroupNode(ast) && (ast.op === 'and' || ast.op === 'or')) {
    const rows = ast.conditions.filter(isConditionNode).map(leafToRow);
    return { match: ast.op, rows: rows.length ? rows : [emptyEventFilterRow()] };
  }
  if (ast && isConditionNode(ast)) return { match: 'and', rows: [leafToRow(ast)] };
  return { match: 'and', rows: [emptyEventFilterRow()] };
}

/**
 * Serialize the editor form → a payload-filter AstNode (or null when no row has a
 * field). Every leaf is namespaced `payload.<key>`; values are typed via the same
 * `parseValue` the segment builder uses (numbers, comma-lists for in/not in,
 * undefined for `exists`). The runner's `evaluateEventPayloadFilter` REJECTS a
 * non-`payload.*` field, so the prefix is mandatory (never interpolated).
 */
export function writeEventPayloadFilter(form: EventFilterForm): AstNode | null {
  const conditions: ConditionNode[] = form.rows
    .filter((r) => r.field.trim().length > 0)
    .map((r) => {
      const key = r.field.trim();
      const field = key.startsWith(PAYLOAD_PREFIX) ? key : PAYLOAD_PREFIX + key;
      if (r.operator === 'exists') return { field, operator: 'exists' };
      return { field, operator: r.operator, value: parseValue(r.operator, r.value) };
    });
  if (conditions.length === 0) return null;
  return { op: form.match, conditions };
}

// ── SEND ───────────────────────────────────────────────────────────────────────

/** A send node NEEDS an email when it has no/empty template_id (replaces the
 *  phase-5 'placeholder' sentinel). Drives the SEND editor's picker vs instance. */
export function sendNodeNeedsEmail(node: DslNode): boolean {
  const t = (node as { template_id?: unknown }).template_id;
  return typeof t !== 'string' || t.trim().length === 0;
}

/** The attached email copy id of a send node (null when none attached). */
export function sendNodeTemplateId(node: DslNode): string | null {
  const t = (node as { template_id?: unknown }).template_id;
  return typeof t === 'string' && t.trim().length > 0 ? t : null;
}

/** A send node's medium ('email' default). */
export type SendMedium = 'email' | 'sms' | 'whatsapp';

/** Whether a send medium is a text channel (sms/whatsapp). */
export function isTextSendMedium(m: string): m is 'sms' | 'whatsapp' {
  return m === 'sms' || m === 'whatsapp';
}

/** The send node's medium ('email' default, back-compat for an untagged send). */
export function sendNodeMedium(node: DslNode): SendMedium {
  const m = (node as { medium?: unknown }).medium;
  return m === 'sms' || m === 'whatsapp' ? m : 'email';
}

/** The SEND editor's channel form: medium + (text body for sms/whatsapp) + the
 *  per-node TOPIC the dispatcher gates this send on. Missing/null = no gate. */
export interface SendForm {
  readonly medium: SendMedium;
  readonly textBody: string;
  /** Optional — defaults to null (no topic). */
  readonly topicId?: string | null;
}

/** A send node's per-node TOPIC id (null when none set). The dispatcher gates the
 *  send on this — a recipient unsubscribed from this topic is skipped. */
export function sendNodeTopicId(node: DslNode): string | null {
  const t = (node as { topic_id?: unknown }).topic_id;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

/** Read a send node into its channel form (medium + body + topic). */
export function readSendConfig(node: DslNode): SendForm {
  const tb = (node as { text_body?: unknown }).text_body;
  return {
    medium: sendNodeMedium(node),
    textBody: typeof tb === 'string' ? tb : '',
    topicId: sendNodeTopicId(node),
  };
}

/**
 * Serialize a send node's channel config (medium + body + topic). For EMAIL the
 * body is dropped and the existing template copy id (`keepTemplateId`) is
 * preserved — the email instance is attached/designed through the clone flow,
 * not this editor. For a TEXT send (sms/whatsapp) the trimmed body is carried
 * and NO template_id is set. topic_id (per-node) is stamped on either channel.
 * Edges are re-applied by applyNodeConfig.
 */
export function writeSendConfig(form: SendForm, keepTemplateId?: string | null): DslNode {
  // applyNodeConfig MERGES the patch onto the existing node, so to flip channels
  // cleanly we must explicitly clear the OTHER channel's fields (undefined keys are
  // dropped on JSON persist) — otherwise a stale template_id/text_body strands.
  const topic_id = form.topicId ?? undefined;
  if (isTextSendMedium(form.medium)) {
    return { type: 'action', kind: 'send', medium: form.medium, text_body: form.textBody.trim(), template_id: undefined, topic_id } as unknown as DslNode;
  }
  return { type: 'action', kind: 'send', medium: 'email', template_id: keepTemplateId ?? undefined, text_body: undefined, topic_id } as unknown as DslNode;
}

// ── UPDATE-PROFILE (set_attribute) ──────────────────────────────────────────────

export type ValueMode = 'literal' | 'expression' | 'js';

/** One key/value assignment row in the update-profile editor (Feature B). */
export interface AssignmentRow {
  readonly key: string;
  readonly mode: ValueMode;
  /** literal mode: the verbatim value (string form in the editor). */
  readonly literal: string;
  /** expression mode: the {{customer.*}}/{{event.*}} token string. */
  readonly expression: string;
  /** js mode: a sandboxed JS snippet (evaluated NODE-side; customer/event in scope). */
  readonly js: string;
}

/** The update-profile editor form: a LIST of assignment rows. */
export interface SetAttributeForm {
  readonly rows: readonly AssignmentRow[];
}

/** A blank assignment row (the editor starts with one). */
export function emptyAssignmentRow(): AssignmentRow {
  return { key: '', mode: 'literal', literal: '', expression: '', js: '' };
}

/** Read ONE value spec (or legacy bare scalar) into an assignment row's mode fields. */
function readValueIntoRow(key: string, v: unknown): AssignmentRow {
  if (isExpressionSpec(v)) {
    return { key, mode: 'expression', literal: '', expression: v.expression, js: '' };
  }
  if (isJsSpec(v)) {
    return { key, mode: 'js', literal: '', expression: '', js: v.code };
  }
  if (isLiteralSpec(v)) {
    return { key, mode: 'literal', literal: scalarToString(v.value), expression: '', js: '' };
  }
  // Legacy bare scalar (or absent) → literal.
  return { key, mode: 'literal', literal: v === undefined || v === null ? '' : scalarToString(v), expression: '', js: '' };
}

/**
 * Read a set_attribute node into its editable form (a LIST of rows). An
 * `assignments` array (Feature B) maps each entry to a row; a LEGACY single
 * key/value reads into a 1-row list (back-compat); an empty node reads as one blank
 * row (the editor always shows at least one).
 */
export function readSetAttributeValue(node: DslNode): SetAttributeForm {
  const n = node as { key?: string; value?: unknown; assignments?: ReadonlyArray<{ key?: unknown; value?: unknown }> };
  const list = n.assignments;
  if (Array.isArray(list) && list.length > 0) {
    return { rows: list.map((a) => readValueIntoRow(typeof a.key === 'string' ? a.key : '', a.value)) };
  }
  if (typeof n.key === 'string' && n.key.length > 0) {
    return { rows: [readValueIntoRow(n.key, n.value)] };
  }
  return { rows: [emptyAssignmentRow()] };
}

/** Serialize one assignment row's value to its ValueSpec by mode. */
function rowValueSpec(row: AssignmentRow): ValueSpec {
  if (row.mode === 'expression') return { kind: 'expression', expression: row.expression.trim() };
  if (row.mode === 'js') return { kind: 'js', code: row.js };
  return { kind: 'literal', value: row.literal };
}

/**
 * Serialize a set_attribute to an `assignments` LIST (Feature B). Rows with a blank
 * key are DROPPED. Each surviving row's value is a ValueSpec by mode (literal |
 * expression | js). The single key/value form is superseded by this list — the
 * editor always emits the list, the runner accepts both.
 */
export function writeSetAttributeConfig(form: SetAttributeForm): DslNode {
  const assignments = form.rows
    .filter((r) => r.key.trim().length > 0)
    .map((r) => ({ key: r.key.trim(), value: rowValueSpec(r) }));
  return { type: 'action', kind: 'set_attribute', assignments };
}

/** Whether the form has at least one assignment with a non-empty key (the save gate). */
export function setAttributeFormHasKey(form: SetAttributeForm): boolean {
  return form.rows.some((r) => r.key.trim().length > 0);
}

// ── UPDATE-JOURNEY (set_journey) ───────────────────────────────────────────────
// Shares EXACTLY the same form shape, value modes, and validation as
// set_attribute — only the emitted DSL `kind` differs. The runner writes the
// resolved assignments to `enrollment.state.journey` (per-enrollment vars) so
// they're readable via {{journey.<key>}} in this campaign's communications.

/** Read a set_journey node into the shared editor form (same shape as set_attribute). */
export function readSetJourneyValue(node: DslNode): SetAttributeForm {
  return readSetAttributeValue(node);
}

/** Serialize the shared editor form to a set_journey assignments LIST. */
export function writeSetJourneyConfig(form: SetAttributeForm): DslNode {
  const assignments = form.rows
    .filter((r) => r.key.trim().length > 0)
    .map((r) => ({ key: r.key.trim(), value: rowValueSpec(r) }));
  return { type: 'action', kind: 'set_journey', assignments };
}

function scalarToString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ── WEBHOOK ──────────────────────────────────────────────────────────────────────

export interface WebhookHeaderRow {
  readonly name: string;
  readonly value: string;
}

export interface WebhookForm {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers: readonly WebhookHeaderRow[];
  readonly bodyTemplate: string;
  readonly timeoutMs: string;
  readonly maxRetries: string;
  /** The write-only secret/auth-header VALUE the user just typed (never re-read). */
  readonly secret: string;
  /** The secret HEADER NAME (e.g. Authorization). */
  readonly secretHeader: string;
  /** True when a secret is already persisted (the editor shows a placeholder). */
  readonly hasSecret: boolean;
}

/** A header name treated as the write-only secret/auth header. */
const SECRET_HEADER_RE = /^(authorization|x-.*-?(secret|token|key)|api[-_]?key)$/i;

/**
 * Read a webhook node WITHOUT its secret value (write-only). The persisted secret
 * header NAME and the fact one exists are surfaced (so the editor renders a
 * placeholder), but its VALUE is never echoed back into the editable form.
 */
export function readWebhookConfig(node: DslNode): WebhookForm {
  const n = node as {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    bodyTemplate?: string;
    timeoutMs?: number;
    maxRetries?: number;
  };
  const allHeaders = n.headers && typeof n.headers === 'object' ? n.headers : {};
  const plainHeaders: WebhookHeaderRow[] = [];
  let secretHeader = '';
  let hasSecret = false;
  for (const [name, value] of Object.entries(allHeaders)) {
    if (SECRET_HEADER_RE.test(name)) {
      secretHeader = name;
      hasSecret = true; // a stored secret — value is NEVER read back
    } else {
      plainHeaders.push({ name, value: String(value) });
    }
  }
  return {
    url: typeof n.url === 'string' ? n.url : '',
    method: isWebhookMethod(n.method) ? n.method : 'POST',
    headers: plainHeaders,
    bodyTemplate: typeof n.bodyTemplate === 'string' ? n.bodyTemplate : '',
    timeoutMs: typeof n.timeoutMs === 'number' ? String(n.timeoutMs) : '',
    maxRetries: typeof n.maxRetries === 'number' ? String(n.maxRetries) : '',
    secret: '',
    secretHeader,
    hasSecret,
  };
}

function isWebhookMethod(m: unknown): m is WebhookForm['method'] {
  return m === 'GET' || m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

export interface WriteWebhookResult {
  readonly node: DslNode | null;
  readonly error: string | null;
}

/**
 * Serialize a webhook. Validates client-side (http(s) only, positive timeoutMs,
 * non-negative maxRetries) and returns a typed error when invalid (the editor
 * blocks save + shows it inline). The secret header is written ONLY when a NEW
 * secret value was typed; otherwise the previously-persisted header is preserved
 * UNCHANGED (`existingSecretHeaders` carries the prior secret entries verbatim so
 * an unedited secret survives a save — but is never surfaced into the form).
 */
export function writeWebhookConfig(
  form: WebhookForm,
  existingSecretHeaders: Readonly<Record<string, string>> = {},
): WriteWebhookResult {
  const url = form.url.trim();
  if (!url) return { node: null, error: 'Enter a webhook URL.' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { node: null, error: 'Enter a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { node: null, error: 'The URL must use http(s).' };
  }
  const headers: Record<string, string> = {};
  for (const h of form.headers) {
    const name = h.name.trim();
    if (name) headers[name] = h.value;
  }
  // Secret header: a freshly-typed secret WINS; else keep the prior persisted one.
  if (form.secret.trim().length > 0 && form.secretHeader.trim().length > 0) {
    headers[form.secretHeader.trim()] = form.secret;
  } else {
    for (const [name, value] of Object.entries(existingSecretHeaders)) headers[name] = value;
  }

  const node: DslNode = { type: 'action', kind: 'webhook', url, method: form.method };
  if (Object.keys(headers).length > 0) (node as { headers?: Record<string, string> }).headers = headers;
  if (form.bodyTemplate.trim().length > 0) (node as { bodyTemplate?: string }).bodyTemplate = form.bodyTemplate;
  if (form.timeoutMs.trim() !== '') {
    const t = Number(form.timeoutMs);
    if (!Number.isFinite(t) || !(t > 0)) return { node: null, error: 'Timeout must be a positive number of ms.' };
    (node as { timeoutMs?: number }).timeoutMs = Math.floor(t);
  }
  if (form.maxRetries.trim() !== '') {
    const r = Number(form.maxRetries);
    if (!Number.isInteger(r) || r < 0) return { node: null, error: 'Retries must be a non-negative integer.' };
    (node as { maxRetries?: number }).maxRetries = r;
  }
  return { node, error: null };
}

/** The persisted SECRET header entries of a webhook node (name→value), so a save
 *  that didn't re-type the secret can preserve it verbatim (write-only round-trip). */
export function webhookSecretHeaders(node: DslNode): Record<string, string> {
  const headers = (node as { headers?: Record<string, string> }).headers;
  const out: Record<string, string> = {};
  if (headers && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) {
      if (SECRET_HEADER_RE.test(name)) out[name] = String(value);
    }
  }
  return out;
}

// ── shared: a node's id + display ───────────────────────────────────────────────

/** Find a canvas node by id (the editor opens against it). */
export function findCanvasNode(model: CanvasModel, nodeId: string): CanvasNode | undefined {
  return model.nodes.find((n) => n.id === nodeId);
}
