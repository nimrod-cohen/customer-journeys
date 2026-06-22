// Shared rule-AST builder UI (§8/§12). EXTRACTED from SegmentBuilder so BOTH the
// segment editor AND the campaign IF/condition node editor mount the EXACT same
// component — they emit the SAME §8 AstNode (buildAstFromGroup), so the server's
// rule→SQL compiler whitelists ONE AST shape (invariant 6 untouched). Every
// data-testid is preserved verbatim (rule-row/rule-field/rule-operator/rule-value/
// add-rule/add-event-rule/rule-group/group-combinator/…) so the existing segment
// e2e contract is unchanged. This component is presentation + the rule rows/groups
// state shape (RuleGroup); the OWNER holds the group and compiles it.
import { api } from '../store/session.js';
import { resolveCustomerField } from '@cdp/shared';
import { Button, Input, Select } from '../ui/kit.js';
import { Suggest, type Fetcher } from '../ui/Suggest.js';
import {
  emptyGroup,
  emptyRow,
  emptyEventRow,
  emptyEventCondition,
  BUILDER_OPERATORS,
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
  'email_status',
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
function RuleListEditor({
  rows,
  onChange,
  allowEmpty = false,
}: {
  rows: RuleRow[];
  onChange: (rows: RuleRow[]) => void;
  /** Allow removing the LAST rule (leaving the list empty) — used at the root when
   * a sub-group exists, so criteria can live entirely in groups. */
  allowEmpty?: boolean;
}) {
  const update = (i: number, patch: Partial<RuleRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const setKind = (i: number, kind: RuleKind) =>
    onChange(rows.map((r, idx) => (idx === i ? (kind === 'event' ? emptyEventRow() : emptyRow()) : r)));
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
                class="w-48"
                value={kind}
                onChange={(e: Event) => setKind(i, (e.target as HTMLSelectElement).value as RuleKind)}
              >
                <option value="field">Attribute / field</option>
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
                <Select
                  data-testid="rule-operator"
                  class="w-28"
                  value={row.operator}
                  onChange={(e: Event) => update(i, { operator: (e.target as HTMLSelectElement).value as BuilderOperator })}
                >
                  {BUILDER_OPERATORS.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </Select>
                {row.operator !== 'exists' ? (
                  <Suggest
                    testId="rule-value"
                    wrapperClass="relative w-40"
                    value={row.value}
                    onChange={(v) => update(i, { value: v })}
                    fetcher={(() => {
                      // Resolve the customer.* shorthand too: customer.tier and
                      // attributes.tier both autocomplete the attribute's values.
                      const canon = resolveCustomerField(row.field);
                      return canon.startsWith('attributes.') ? fetchAttrValues(canon.slice('attributes.'.length)) : null;
                    })()}
                    placeholder="value"
                  />
                ) : null}
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
                      <Select
                        data-testid="event-cond-op"
                        class="w-24"
                        value={c.operator}
                        onChange={(e: Event) =>
                          setCond(i, j, { operator: (e.target as HTMLSelectElement).value as BuilderOperator })
                        }
                      >
                        {BUILDER_OPERATORS.map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </Select>
                      {c.operator !== 'exists' ? (
                        <Suggest
                          testId="event-cond-value"
                          wrapperClass="relative w-36"
                          placeholder="value"
                          value={c.value}
                          onChange={(v) => setCond(i, j, { value: v })}
                          fetcher={fetchPayloadValues(row.field, c.field)}
                        />
                      ) : null}
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
}: {
  group: RuleGroup;
  onChange: (group: RuleGroup) => void;
  allowEmptyRootRules?: boolean;
}) {
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
        <RuleListEditor rows={group.rows} onChange={setRows} allowEmpty={allowEmptyRootRules} />

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
            <RuleListEditor rows={g.rows} onChange={(r) => updateGroup(gi, { rows: r })} />
          </div>
        ))}

        <Button data-testid="add-group" variant="secondary" size="sm" onClick={() => setGroups([...group.groups, emptyGroup()])}>
          + Add group
        </Button>
      </div>
    </div>
  );
}
