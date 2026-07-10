// Shared rule-AST builder UI (§8/§12). EXTRACTED from SegmentBuilder so BOTH the
// segment editor AND the campaign IF/condition node editor mount the EXACT same
// component — they emit the SAME §8 AstNode (buildAstFromGroup), so the server's
// rule→SQL compiler whitelists ONE AST shape (invariant 6 untouched). Every
// data-testid is preserved verbatim (rule-row/rule-field/rule-operator/rule-value/
// add-rule/add-event-rule/rule-group/group-combinator/…) so the existing segment
// e2e contract is unchanged. This component is presentation + the rule rows/groups
// state shape (RuleGroup); the OWNER holds the group and compiles it.
import type { JSX } from 'preact';
import { api } from '../store/session.js';
import { resolveCustomerField } from '@cdp/shared';
import { Button, Input, Select } from '../ui/kit.js';
import { Suggest, type Fetcher } from '../ui/Suggest.js';
import {
  emptyGroup,
  emptyRow,
  emptyEventRow,
  emptyEventCondition,
  emptySegmentRow,
  emptyTriggerEventRow,
  emptyJourneyRow,
  OPERATOR_GROUPS,
  OPERATOR_META,
  EVENT_COUNT_OPS,
  isCountOp,
  type RuleRow,
  type RuleKind,
  type RuleGroup,
  type EventCondition,
  type EventCountOp,
  type EventWindow,
  type BuilderOperator,
  type Combinator,
} from './ast-builder.js';

// Fetchers for the autosuggest boxes — each returns the existing distinct values
// matching `q` (workspace-scoped, capped server-side). A null fetcher = plain box.
// The `Suggest` combobox itself lives in ../ui/Suggest (shared with the campaign
// trigger editor); these just bind it to the right endpoint.
const fetchAttrValues = (key: string): Fetcher =>
  key ? (q) => api.get<{ values: string[] }>('/profiles/attribute-values', { query: { key, q } }).then((r) => r.values) : null;
const fetchEventTypes: Fetcher = (q) =>
  api.get<{ values: string[] }>('/events/types', { query: { q } }).then((r) => r.values);
const fetchPayloadKeys = (type: string): Fetcher => (q) =>
  api.get<{ values: string[] }>('/events/payload-keys', { query: { type, q } }).then((r) => r.values);
const fetchPayloadValues = (type: string, key: string): Fetcher =>
  key ? (q) => api.get<{ values: string[] }>('/events/payload-values', { query: { type, key, q } }).then((r) => r.values) : null;

/** Canonical built-in field paths always offered for a 'field' rule. The
 *  `customer.*` namespace is the same shorthand used in email tags (§11):
 *  `customer.tier` ≡ `attributes.tier`, `customer.email` ≡ `email`. The
 *  workspace's REAL custom attribute keys are merged in at runtime (below). */
const FIELD_SUGGESTIONS = [
  'email',
  'email_status',
  'external_id',
  'created_at',
  'total_events',
  'monetary_total',
  'last_event_at',
  'features.counters.purchase_30d',
];

/** Suggestions for a field rule: the built-in fields PLUS the workspace's live
 *  custom attribute keys (offered as `customer.<key>`, the §11 shorthand) so a
 *  freshly-added attribute like `yp_status` shows up. Filters by `q`
 *  (case-insensitive substring) and dedupes; never throws (a failed fetch just
 *  falls back to the built-ins). */
const fetchFieldSuggestions: Fetcher = async (q) => {
  let attrFields: string[] = [];
  try {
    const r = await api.get<{ keys: string[] }>('/profiles/attribute-keys');
    // Offer each live attribute key in BOTH §11-equivalent forms so a match is
    // found whichever prefix the user types (the default row uses `attributes.`,
    // the email-tag shorthand uses `customer.`).
    attrFields = r.keys.flatMap((k) => [`customer.${k}`, `attributes.${k}`]);
  } catch {
    // ignore — fall back to the built-in list only
  }
  const seen = new Set<string>();
  const all = [...FIELD_SUGGESTIONS, ...attrFields].filter((f) => {
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });
  const needle = q.trim().toLowerCase();
  return needle ? all.filter((f) => f.toLowerCase().includes(needle)) : all;
};
/**
 * Grouped operator dropdown. Renders an `<optgroup>` per semantic group
 * (string-or-number, string-only, timestamp) so the comparator is typed.
 * Shared by all 3 condition sites: profile/feature rows, event-payload
 * filters, and trigger-event payload filters.
 */
function OperatorSelect({
  value, onChange, testId, className,
}: {
  value: BuilderOperator;
  onChange: (op: BuilderOperator) => void;
  testId: string;
  className?: string;
}): JSX.Element {
  return (
    <Select
      data-testid={testId}
      class={className ?? 'w-48'}
      value={value}
      onChange={(e: Event) => onChange((e.target as HTMLSelectElement).value as BuilderOperator)}
    >
      {OPERATOR_GROUPS.map((g) => (
        <optgroup key={g.group} label={g.label}>
          {g.ops.map((op) => (
            <option key={op.value} value={op.value}>
              {op.label}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

/**
 * Value-side input that swaps widget by operator shape.
 *   - none: nothing (exists / not exists)
 *   - pair: "min,max" → two boxes, joined back into row.value as "min,max"
 *   - days: <input type=number> placeholder "days"
 *   - date: <input type=date>
 *   - number: <input type=number>
 *   - list:  text box (comma-separated)
 *   - text:  Suggest (with optional autocomplete fetcher)
 */
function ValueInputs({
  operator, value, onChange, fetcher, testId,
}: {
  operator: BuilderOperator;
  value: string;
  onChange: (v: string) => void;
  fetcher: Fetcher;
  testId: string;
}): JSX.Element | null {
  const meta = OPERATOR_META[operator];
  const shape = meta?.valueShape ?? 'text';
  if (shape === 'none') return null;
  if (shape === 'pair') {
    const [a = '', b = ''] = value.split(',').map((s) => s.trim());
    const set = (na: string, nb: string) => onChange(`${na},${nb}`);
    return (
      <span class="flex items-center gap-1">
        <input
          data-testid={`${testId}-min`}
          class="input w-20"
          value={a}
          placeholder="min"
          onInput={(e) => set((e.target as HTMLInputElement).value, b)}
        />
        <span class="text-stone-500">–</span>
        <input
          data-testid={`${testId}-max`}
          class="input w-20"
          value={b}
          placeholder="max"
          onInput={(e) => set(a, (e.target as HTMLInputElement).value)}
        />
      </span>
    );
  }
  if (shape === 'duration') {
    // Value encoded as "amount|unit" (e.g. "7|days"). The unit select is part
    // of the value column itself, not a separate attribute on the operator.
    const [amtRaw = '', unitRaw = 'days'] = value.split('|');
    const setAmount = (n: string) => onChange(`${n}|${unitRaw}`);
    const setUnit = (u: string) => onChange(`${amtRaw}|${u}`);
    return (
      <span class="flex items-center gap-1">
        <input
          data-testid={`${testId}-amount`}
          type="number"
          min="1"
          class="input w-24"
          value={amtRaw}
          placeholder="N"
          onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
        />
        <Select
          data-testid={`${testId}-unit`}
          class="w-28"
          value={unitRaw}
          onChange={(e: Event) => setUnit((e.target as HTMLSelectElement).value)}
        >
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </Select>
      </span>
    );
  }
  if (shape === 'date') {
    return (
      <input
        data-testid={testId}
        type="date"
        class="input w-44"
        value={value}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
    );
  }
  if (shape === 'number') {
    return (
      <input
        data-testid={testId}
        type="number"
        class="input w-32"
        value={value}
        placeholder="value"
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
    );
  }
  // text + list — Suggest, with optional autocomplete fetcher.
  return (
    <Suggest
      testId={testId}
      wrapperClass="relative w-40"
      value={value}
      onChange={onChange}
      fetcher={fetcher}
      placeholder={shape === 'list' ? 'value1, value2, …' : 'value'}
    />
  );
}

/** Friendly labels for the event count operator. */
const EVENT_OP_LABEL: Record<EventCountOp, string> = {
  occurred: 'occurred',
  not_occurred: 'did not occur',
  '>=': 'occurred ≥ N times',
  '>': 'occurred > N times',
  '=': 'occurred exactly N times',
  '<=': 'occurred ≤ N times',
  '<': 'occurred < N times',
};

/**
 * Editor for ONE list of rules (a group's rules). Pure-ish: takes the rows and an
 * onChange(rows) and renders the per-rule UI (field/event, operators, payload
 * filters, autosuggest). Reused by the root group and each sub-group.
 */
/** Context extras: which rule kinds are available + the data they need. `audience`
 *  (broadcast audience) is like `segment` PLUS the segment-membership rule kind, but
 *  WITHOUT the campaign-only trigger-event / journey kinds. */
interface RuleBuilderCtx {
  context: 'segment' | 'campaign' | 'audience';
  triggerIsEvent: boolean;
  segments: { id: string; name: string }[];
  triggerEventType: string;
}

/** A blank row for a chosen kind. */
function blankRowForKind(kind: RuleKind): RuleRow {
  switch (kind) {
    case 'event':
      return emptyEventRow();
    case 'segment':
      return emptySegmentRow();
    case 'trigger_event':
      return emptyTriggerEventRow();
    case 'journey':
      return emptyJourneyRow();
    default:
      return emptyRow();
  }
}

function RuleListEditor({
  rows,
  onChange,
  allowEmpty = false,
  ctx,
}: {
  rows: RuleRow[];
  onChange: (rows: RuleRow[]) => void;
  /** Allow removing the LAST rule (leaving the list empty) — used at the root when
   * a sub-group exists, so criteria can live entirely in groups. */
  allowEmpty?: boolean;
  ctx: RuleBuilderCtx;
}) {
  const update = (i: number, patch: Partial<RuleRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const setKind = (i: number, kind: RuleKind) =>
    onChange(rows.map((r, idx) => (idx === i ? blankRowForKind(kind) : r)));
  const setCond = (i: number, j: number, patch: Partial<EventCondition>) =>
    onChange(
      rows.map((r, idx) =>
        idx === i ? { ...r, conditions: (r.conditions ?? []).map((c, k) => (k === j ? { ...c, ...patch } : c)) } : r,
      ),
    );
  const addCond = (i: number) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, conditions: [...(r.conditions ?? []), emptyEventCondition()] } : r)));
  const removeCond = (i: number, j: number) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, conditions: (r.conditions ?? []).filter((_, k) => k !== j) } : r)));

  return (
    <div class="space-y-3">
      {rows.map((row, i) => {
        const kind: RuleKind = row.kind ?? 'field';
        return (
          <div data-testid="rule-row" key={i} class="rounded-xl border border-stone-200 bg-stone-50/60 p-3">
            <div class="mb-2 flex items-center gap-2">
              <Select
                data-testid="rule-kind"
                class="w-52"
                value={kind}
                onChange={(e: Event) => setKind(i, (e.target as HTMLSelectElement).value as RuleKind)}
              >
                <option value="field">Profile attribute</option>
                {ctx.context === 'campaign' && ctx.triggerIsEvent ? (
                  <option value="trigger_event">Trigger event</option>
                ) : null}
                {ctx.context === 'campaign' || ctx.context === 'audience' ? (
                  <option value="segment">Segment</option>
                ) : null}
                {ctx.context === 'campaign' ? <option value="journey">Journey attribute</option> : null}
                <option value="event">Event</option>
              </Select>
              {rows.length > 1 || allowEmpty ? (
                <Button
                  data-testid="rule-remove"
                  variant="ghost"
                  size="sm"
                  aria-label="Remove rule"
                  onClick={() => removeRow(i)}
                  class="ml-auto"
                >
                  ✕
                </Button>
              ) : null}
            </div>

            {kind === 'field' ? (
              <div class="flex flex-wrap items-center gap-2">
                <Suggest
                  testId="rule-field"
                  wrapperClass="relative min-w-[12rem] flex-1"
                  inputClass="font-mono text-xs"
                  value={row.field}
                  onChange={(v) => update(i, { field: v })}
                  fetcher={fetchFieldSuggestions}
                  placeholder="customer.tier, email_status, features.counters.purchase_30d…"
                />
                <OperatorSelect
                  testId="rule-operator"
                  value={row.operator}
                  onChange={(op) => update(i, { operator: op })}
                />
                <ValueInputs
                  testId="rule-value"
                  operator={row.operator}
                  value={row.value}
                  onChange={(v) => update(i, { value: v })}
                  fetcher={(() => {
                    // Resolve the customer.* shorthand too: customer.tier and
                    // attributes.tier both autocomplete the attribute's values.
                    const canon = resolveCustomerField(row.field);
                    return canon.startsWith('attributes.') ? fetchAttrValues(canon.slice('attributes.'.length)) : null;
                  })()}
                />
              </div>
            ) : kind === 'journey' ? (
              <div class="flex flex-wrap items-center gap-2">
                <Input
                  data-testid="rule-journey-key"
                  class="min-w-[12rem] flex-1 font-mono text-xs"
                  placeholder="journey variable (e.g. cohort) — set by an Update-journey step"
                  value={row.field}
                  onInput={(e: Event) => update(i, { field: (e.target as HTMLInputElement).value })}
                />
                <OperatorSelect
                  testId="rule-operator"
                  value={row.operator}
                  onChange={(op) => update(i, { operator: op })}
                />
                <ValueInputs
                  testId="rule-value"
                  operator={row.operator}
                  value={row.value}
                  onChange={(v) => update(i, { value: v })}
                  fetcher={null}
                />
              </div>
            ) : kind === 'segment' ? (
              <div class="flex flex-wrap items-center gap-2">
                <Select
                  data-testid="rule-segment-op"
                  class="w-44"
                  value={row.segmentNegate ? 'not' : 'is'}
                  onChange={(e: Event) => update(i, { segmentNegate: (e.target as HTMLSelectElement).value === 'not' })}
                >
                  <option value="is">is a member of</option>
                  <option value="not">is NOT a member of</option>
                </Select>
                <Select
                  data-testid="rule-segment"
                  class="min-w-0 flex-1"
                  value={row.segmentId ?? ''}
                  onChange={(e: Event) => update(i, { segmentId: (e.target as HTMLSelectElement).value })}
                >
                  <option value="">Choose a segment…</option>
                  {ctx.segments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : kind === 'trigger_event' ? (
              <div class="space-y-2">
                <p class="text-xs text-stone-500">
                  Refine by the triggering event&apos;s data. The trigger already matched the event, so there&apos;s no
                  &ldquo;when&rdquo; — only its payload.
                </p>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm text-stone-500">match</span>
                  <Select
                    data-testid="trigger-match"
                    class="w-24"
                    value={row.triggerMatch ?? 'all'}
                    onChange={(e: Event) => update(i, { triggerMatch: (e.target as HTMLSelectElement).value as 'all' | 'any' })}
                  >
                    <option value="all">all</option>
                    <option value="any">any</option>
                  </Select>
                  <span class="text-sm text-stone-500">of these event-data filters</span>
                </div>
                <div class="rounded-lg border border-stone-200 bg-white p-2.5">
                  {(row.conditions ?? []).length === 0 ? (
                    <p class="text-xs text-stone-400">No event-data filters — matches any time this event triggered.</p>
                  ) : null}
                  {(row.conditions ?? []).map((c, j) => (
                    <div data-testid="trigger-cond-row" key={j} class="mt-1.5 flex flex-wrap items-center gap-2">
                      <Suggest
                        testId="trigger-cond-field"
                        wrapperClass="relative min-w-[8rem] flex-1"
                        inputClass="font-mono text-xs"
                        placeholder="payload key (e.g. amount)"
                        value={c.field}
                        onChange={(v) => setCond(i, j, { field: v })}
                        fetcher={fetchPayloadKeys(ctx.triggerEventType)}
                      />
                      <OperatorSelect
                        testId="trigger-cond-op"
                        value={c.operator}
                        onChange={(op) => setCond(i, j, { operator: op })}
                      />
                      <ValueInputs
                        testId="trigger-cond-value"
                        operator={c.operator}
                        value={c.value}
                        onChange={(v) => setCond(i, j, { value: v })}
                        fetcher={fetchPayloadValues(ctx.triggerEventType, c.field)}
                      />
                      <Button data-testid="trigger-cond-remove" variant="ghost" size="sm" aria-label="Remove filter" onClick={() => removeCond(i, j)}>
                        ✕
                      </Button>
                    </div>
                  ))}
                  <Button data-testid="trigger-cond-add" variant="ghost" size="sm" class="mt-1.5" onClick={() => addCond(i)}>
                    + Add event-data filter
                  </Button>
                </div>
              </div>
            ) : (
              <div class="space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm text-stone-500">did event</span>
                  <Suggest
                    testId="event-name"
                    wrapperClass="relative min-w-[10rem] flex-1"
                    inputClass="font-mono text-xs"
                    placeholder="e.g. lead, purchase"
                    value={row.field}
                    onChange={(v) => update(i, { field: v })}
                    fetcher={fetchEventTypes}
                  />
                  <Select
                    data-testid="event-op"
                    class="w-56"
                    value={row.eventOp ?? 'occurred'}
                    onChange={(e: Event) => update(i, { eventOp: (e.target as HTMLSelectElement).value as EventCountOp })}
                  >
                    {EVENT_COUNT_OPS.map((op) => (
                      <option key={op} value={op}>
                        {EVENT_OP_LABEL[op]}
                      </option>
                    ))}
                  </Select>
                  {isCountOp(row.eventOp ?? 'occurred') ? (
                    <Input
                      data-testid="event-count"
                      type="number"
                      class="w-20"
                      placeholder="N"
                      value={row.value}
                      onInput={(e: Event) => update(i, { value: (e.target as HTMLInputElement).value })}
                    />
                  ) : null}
                </div>

                {/* Time window: ever, or within the last N days (makes membership time-dependent). */}
                <div class="flex flex-wrap items-center gap-2">
                  <Select
                    data-testid="event-window"
                    class="w-44"
                    value={row.eventWindow ?? 'ever'}
                    onChange={(e: Event) => update(i, { eventWindow: (e.target as HTMLSelectElement).value as EventWindow })}
                  >
                    <option value="ever">ever</option>
                    <option value="within">within the last</option>
                  </Select>
                  {(row.eventWindow ?? 'ever') === 'within' ? (
                    <>
                      <Input
                        data-testid="event-window-days"
                        type="number"
                        class="w-20"
                        placeholder="N"
                        value={row.eventWindowDays ?? ''}
                        onInput={(e: Event) => update(i, { eventWindowDays: (e.target as HTMLInputElement).value })}
                      />
                      <span class="text-sm text-stone-500">days</span>
                    </>
                  ) : null}
                </div>

                <div class="rounded-lg border border-stone-200 bg-white p-2.5">
                  <p class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone-500">
                    with all of these event attributes
                  </p>
                  {(row.conditions ?? []).length === 0 ? (
                    <p class="text-xs text-stone-400">No event-attribute filters.</p>
                  ) : null}
                  {(row.conditions ?? []).map((c, j) => (
                    <div data-testid="event-cond-row" key={j} class="mt-1.5 flex flex-wrap items-center gap-2">
                      <Suggest
                        testId="event-cond-field"
                        wrapperClass="relative min-w-[8rem] flex-1"
                        inputClass="font-mono text-xs"
                        placeholder="payload key (e.g. interest)"
                        value={c.field}
                        onChange={(v) => setCond(i, j, { field: v })}
                        fetcher={fetchPayloadKeys(row.field)}
                      />
                      <OperatorSelect
                        testId="event-cond-op"
                        value={c.operator}
                        onChange={(op) => setCond(i, j, { operator: op })}
                      />
                      <ValueInputs
                        testId="event-cond-value"
                        operator={c.operator}
                        value={c.value}
                        onChange={(v) => setCond(i, j, { value: v })}
                        fetcher={fetchPayloadValues(row.field, c.field)}
                      />
                      <Button
                        data-testid="event-cond-remove"
                        variant="ghost"
                        size="sm"
                        aria-label="Remove event attribute filter"
                        onClick={() => removeCond(i, j)}
                      >
                        ✕
                      </Button>
                    </div>
                  ))}
                  <Button data-testid="event-cond-add" variant="ghost" size="sm" class="mt-1.5" onClick={() => addCond(i)}>
                    + Add event attribute filter
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div class="flex flex-wrap gap-2">
        <Button data-testid="add-rule" variant="ghost" size="sm" onClick={() => onChange([...rows, emptyRow()])}>
          + Add field rule
        </Button>
        <Button data-testid="add-event-rule" variant="ghost" size="sm" onClick={() => onChange([...rows, emptyEventRow()])}>
          + Add event rule
        </Button>
      </div>
    </div>
  );
}

/**
 * RuleBuilder — the full rule-group editor (root rules + the match combinator +
 * optional sub-groups). Controlled: it renders `group` and emits the next group
 * via `onChange`. The owner compiles the group to an AstNode (buildAstFromGroup).
 * `allowEmptyRootRules` lets the segment screen drop the last root rule when a
 * sub-group carries the criteria; the IF editor leaves it at the default.
 */
export function RuleBuilder({
  group,
  onChange,
  allowEmptyRootRules = true,
  context = 'segment',
  triggerIsEvent = false,
  segments = [],
  triggerEventType = '',
}: {
  group: RuleGroup;
  onChange: (group: RuleGroup) => void;
  allowEmptyRootRules?: boolean;
  /** 'campaign' unlocks Trigger-event + Segment + Journey rule kinds (IF nodes only);
   *  'audience' (broadcast) unlocks the Segment rule kind only. */
  context?: 'segment' | 'campaign' | 'audience';
  /** Campaign IF: the trigger is an EVENT trigger → offer "Trigger event". */
  triggerIsEvent?: boolean;
  /** Campaign IF: the workspace segments, for the "Segment" membership picker. */
  segments?: { id: string; name: string }[];
  /** Campaign IF event trigger: the trigger event type, for payload autosuggest. */
  triggerEventType?: string;
}) {
  const ctx: RuleBuilderCtx = { context, triggerIsEvent, segments, triggerEventType };
  const setRows = (rows: RuleRow[]) => onChange({ ...group, rows });
  const setCombinator = (combinator: Combinator) => onChange({ ...group, combinator });
  const setGroups = (groups: RuleGroup[]) => onChange({ ...group, groups });
  const updateGroup = (gi: number, patch: Partial<RuleGroup>) =>
    setGroups(group.groups.map((g, idx) => (idx === gi ? { ...g, ...patch } : g)));
  const removeGroup = (gi: number) => setGroups(group.groups.filter((_, idx) => idx !== gi));

  return (
    <div>
      <div class="flex items-center gap-2">
        <span class="text-xs font-semibold uppercase tracking-wide text-stone-500">Match</span>
        <Select
          data-testid="segment-combinator"
          class="w-28"
          value={group.combinator}
          onChange={(e: Event) => setCombinator((e.target as HTMLSelectElement).value as Combinator)}
        >
          <option value="and">all (AND)</option>
          <option value="or">any (OR)</option>
        </Select>
      </div>

      <div class="mt-3 space-y-3">
        <RuleListEditor rows={group.rows} onChange={setRows} allowEmpty={allowEmptyRootRules} ctx={ctx} />

        {group.groups.map((g, gi) => (
          <div data-testid="rule-group" key={gi} class="rounded-xl border border-brand-200 bg-brand-50/30 p-3">
            <div class="mb-2 flex items-center gap-2">
              <span class="text-xs font-semibold uppercase tracking-wide text-stone-500">Group · match</span>
              <Select
                data-testid="group-combinator"
                class="w-28"
                value={g.combinator}
                onChange={(e: Event) => updateGroup(gi, { combinator: (e.target as HTMLSelectElement).value as Combinator })}
              >
                <option value="and">all (AND)</option>
                <option value="or">any (OR)</option>
              </Select>
              <Button
                data-testid="remove-group"
                variant="ghost"
                size="sm"
                aria-label="Remove group"
                class="ml-auto"
                onClick={() => removeGroup(gi)}
              >
                ✕
              </Button>
            </div>
            <RuleListEditor rows={g.rows} onChange={(r) => updateGroup(gi, { rows: r })} ctx={ctx} />
          </div>
        ))}

        <Button data-testid="add-group" variant="secondary" size="sm" onClick={() => setGroups([...group.groups, emptyGroup()])}>
          + Add group
        </Button>
      </div>
    </div>
  );
}
