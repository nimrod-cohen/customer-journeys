// SegmentBuilder (§12): dynamic rule-AST builder + manual hand-pick/CSV, with a
// LIVE size preview. The AST is assembled by the pure ast-builder and previewed
// via POST /segments/preview (scoped to the active workspace server-side). Manual
// members are added by CSV emails via /segments/:id/import-csv. (Visual redesign;
// all data-testid attributes preserved.)
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import {
  buildAstFromGroup,
  groupFromAst,
  emptyGroup,
  emptyRow,
  emptyEventRow,
  emptyEventCondition,
  BUILDER_OPERATORS,
  EVENT_COUNT_OPS,
  type AstNode,
  type RuleRow,
  type RuleKind,
  type RuleGroup,
  type EventCondition,
  type EventCountOp,
  type BuilderOperator,
  type Combinator,
} from '../segments/ast-builder.js';
import { Badge, Button, Card, Field, Input, PageHeader, Select, Textarea } from '../ui/kit.js';

// Fetchers for the autosuggest boxes — each returns the existing distinct values
// matching `q` (workspace-scoped, capped server-side). A null fetcher = plain box.
type Fetcher = ((q: string) => Promise<string[]>) | null;
const fetchAttrValues = (key: string): Fetcher =>
  key ? (q) => api.get<{ values: string[] }>('/profiles/attribute-values', { query: { key, q } }).then((r) => r.values) : null;
const fetchEventTypes: Fetcher = (q) =>
  api.get<{ values: string[] }>('/events/types', { query: { q } }).then((r) => r.values);
const fetchPayloadKeys = (type: string): Fetcher => (q) =>
  api.get<{ values: string[] }>('/events/payload-keys', { query: { type, q } }).then((r) => r.values);
const fetchPayloadValues = (type: string, key: string): Fetcher =>
  key ? (q) => api.get<{ values: string[] }>('/events/payload-values', { query: { type, key, q } }).then((r) => r.values) : null;

/**
 * Free-text input with autosuggest of EXISTING values via `fetcher`. Suggestions
 * appear on focus and filter as you type (debounced 250ms so we only fetch on a
 * pause). A null fetcher makes it a plain text box.
 */
function Suggest({
  value,
  onChange,
  fetcher,
  placeholder,
  testId,
  wrapperClass = 'relative',
  inputClass = '',
}: {
  value: string;
  onChange: (v: string) => void;
  fetcher: Fetcher;
  placeholder?: string;
  testId: string;
  wrapperClass?: string;
  inputClass?: string;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const doFetch = async (q: string) => {
    if (!fetcher) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    try {
      const vals = (await fetcher(q.trim())).filter((s) => s !== q);
      setSuggestions(vals);
      setOpen(vals.length > 0);
    } catch {
      setSuggestions([]);
      setOpen(false);
    }
  };

  const onInput = (v: string) => {
    onChange(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void doFetch(v), 250);
  };

  return (
    <div ref={ref} class={wrapperClass}>
      <Input
        data-testid={testId}
        class={`w-full ${inputClass}`}
        placeholder={placeholder}
        value={value}
        onInput={(e: Event) => onInput((e.target as HTMLInputElement).value)}
        onFocus={() => void doFetch(value)}
      />
      {open ? (
        <div
          data-testid="value-suggestions"
          class="absolute left-0 z-30 mt-1 max-h-48 w-56 overflow-y-auto rounded-lg border border-stone-200 bg-white p-1 shadow-soft"
        >
          {suggestions.map((s) => (
            <button
              key={s}
              data-testid="value-suggestion"
              type="button"
              class="block w-full truncate rounded px-2 py-1 text-left text-sm text-ink-800 hover:bg-stone-100"
              onClick={() => {
                onChange(s);
                setOpen(false);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Common field paths offered as suggestions for a 'field' rule. */
const FIELD_SUGGESTIONS = [
  'email_status',
  'total_events',
  'monetary_total',
  'last_event_at',
  'attributes.tier',
  'attributes.source',
  'features.counters.purchase_30d',
];
/** Friendly labels for the event count operator. */
const EVENT_OP_LABEL: Record<EventCountOp, string> = {
  occurred: 'has been performed',
  '>=': 'performed ≥ N times',
  '>': 'performed > N times',
  '=': 'performed exactly N times',
  '<=': 'performed ≤ N times',
  '<': 'performed < N times',
};

/**
 * SegmentBuilder is the DESIGNATED create/edit screen. With no `id` it creates a
 * new segment (/segments/new); with an `id` it loads that segment and edits it
 * (/segments/:id). Saving routes back to the list, which re-fetches → reactive.
 */
/**
 * Editor for ONE list of rules (a group's rules). Pure-ish: takes the rows and an
 * onChange(rows) and renders the per-rule UI (field/event, operators, payload
 * filters, autosuggest). Reused by the root group and each sub-group.
 */
function RuleListEditor({ rows, onChange }: { rows: RuleRow[]; onChange: (rows: RuleRow[]) => void }) {
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
                class="w-32"
                value={kind}
                onChange={(e: Event) => setKind(i, (e.target as HTMLSelectElement).value as RuleKind)}
              >
                <option value="field">Attribute / field</option>
                <option value="event">Event</option>
              </Select>
              {rows.length > 1 ? (
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
                <Input
                  data-testid="rule-field"
                  list="field-suggestions"
                  class="min-w-[12rem] flex-1 font-mono text-xs"
                  placeholder="email_status, attributes.tier, features.counters.purchase_30d…"
                  value={row.field}
                  onInput={(e: Event) => update(i, { field: (e.target as HTMLInputElement).value })}
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
                    fetcher={
                      row.field.startsWith('attributes.') ? fetchAttrValues(row.field.slice('attributes.'.length)) : null
                    }
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
                  {(row.eventOp ?? 'occurred') !== 'occurred' ? (
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

export function SegmentBuilder({ id }: { id?: string }) {
  const editing = Boolean(id);
  // The root group: its own combinator + rules, plus optional sub-groups (2-level
  // hierarchy). Root rules and sub-groups are combined by `combinator`.
  const [rows, setRows] = useState<RuleRow[]>([emptyRow()]);
  const [combinator, setCombinator] = useState<Combinator>('and');
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [size, setSize] = useState<number | null>(null);
  const [name, setName] = useState('');
  // The id of the segment being edited or just-created (enables CSV import).
  const [savedId, setSavedId] = useState<string | null>(id ?? null);
  const [saving, setSaving] = useState(false);
  const [csv, setCsv] = useState('');
  const [imported, setImported] = useState<number | null>(null);

  // Edit mode: load the existing segment and hydrate the builder from its AST.
  useEffect(() => {
    if (!id) return;
    void api
      .get<{ segment: { name: string; kind: string; definition: AstNode | null } }>(`/segments/${id}`)
      .then((res) => {
        setName(res.segment.name);
        const g = groupFromAst(res.segment.definition);
        setRows(g.rows);
        setCombinator(g.combinator);
        setGroups(g.groups);
      })
      .catch(() => navigate('/segments'));
  }, [id]);

  // The whole audience as one root group (root rules + sub-groups).
  const rootGroup = (): RuleGroup => ({ combinator, rows, groups });
  const updateGroup = (gi: number, patch: Partial<RuleGroup>) =>
    setGroups((gs) => gs.map((g, idx) => (idx === gi ? { ...g, ...patch } : g)));
  const removeGroup = (gi: number) => setGroups((gs) => gs.filter((_, idx) => idx !== gi));

  const preview = async () => {
    const ast = buildAstFromGroup(rootGroup());
    const res = await api.post<{ size: number }>('/segments/preview', { body: { definition: ast } });
    setSize(res.size);
  };

  const save = async () => {
    setSaving(true);
    try {
      const ast = buildAstFromGroup(rootGroup());
      if (editing && id) {
        await api.put(`/segments/${id}`, { body: { name: name || 'Untitled segment', definition: ast } });
      } else {
        const res = await api.post<{ segment: { id: string } }>('/segments', {
          body: { name: name || 'Untitled segment', kind: 'dynamic_realtime', definition: ast },
        });
        setSavedId(res.segment.id);
      }
      // Return to the list, which re-fetches on mount and shows the change.
      navigate('/segments');
    } finally {
      setSaving(false);
    }
  };

  const importCsv = async () => {
    if (!savedId) return;
    const emails = csv
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await api.post<{ added: number }>(`/segments/${savedId}/import-csv`, { body: { emails } });
    setImported(res.added);
  };

  return (
    <section data-testid="segment-builder">
      <button
        data-testid="segments-back"
        class="btn-ghost mb-4 btn-sm"
        onClick={() => navigate('/segments')}
      >
        ← Back to segments
      </button>
      <PageHeader
        title={editing ? 'Edit segment' : 'New segment'}
        subtitle="Build a dynamic rule-based audience or curate a manual list."
      />

      <div class="max-w-3xl space-y-6">
        {/* Builder */}
        <div class="space-y-6">
          <Card class="p-5">
            <div class="flex flex-wrap items-end gap-3">
              <Field label="Segment name" class="min-w-[16rem] flex-1">
                <Input
                  data-testid="segment-name"
                  placeholder="e.g. High-value (30d)"
                  value={name}
                  onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
                />
              </Field>
              <Field label="Match">
                <Select
                  data-testid="segment-combinator"
                  value={combinator}
                  onChange={(e: Event) =>
                    setCombinator((e.target as HTMLSelectElement).value as Combinator)
                  }
                >
                  <option value="and">all (AND)</option>
                  <option value="or">any (OR)</option>
                </Select>
              </Field>
            </div>

            <datalist id="field-suggestions">
              {FIELD_SUGGESTIONS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>

                        <div class="mt-5 space-y-3">
              <span class="label">Rules</span>
              <RuleListEditor rows={rows} onChange={setRows} />

              {groups.map((g, gi) => (
                <div
                  data-testid="rule-group"
                  key={gi}
                  class="rounded-xl border border-brand-200 bg-brand-50/30 p-3"
                >
                  <div class="mb-2 flex items-center gap-2">
                    <span class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                      Group · match
                    </span>
                    <Select
                      data-testid="group-combinator"
                      class="w-28"
                      value={g.combinator}
                      onChange={(e: Event) =>
                        updateGroup(gi, { combinator: (e.target as HTMLSelectElement).value as Combinator })
                      }
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

              <Button
                data-testid="add-group"
                variant="secondary"
                size="sm"
                onClick={() => setGroups((gs) => [...gs, emptyGroup()])}
              >
                + Add group
              </Button>
            </div>


            <div class="mt-5 flex flex-wrap items-center gap-3 border-t border-stone-100 pt-4">
              <Button data-testid="preview-size" variant="secondary" onClick={preview}>
                Preview size
              </Button>
              <Button data-testid="save-segment" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Save segment'}
              </Button>
              {size !== null ? (
                <span data-testid="segment-size" class="text-sm text-stone-600">
                  Matches <b class="text-ink-900">{size}</b> profile{size === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
          </Card>

          {/* Manual members */}
          <Card class="p-5">
            <h2 class="text-base font-bold text-ink-900">Manual members (CSV)</h2>
            <p class="mt-1 text-sm text-stone-500">
              Paste comma- or newline-separated emails. Save the segment first.
            </p>
            <div class="mt-3">
              <Textarea
                data-testid="csv-input"
                value={csv}
                onInput={(e: Event) => setCsv((e.target as HTMLTextAreaElement).value)}
                placeholder="alice@acme.com, bob@acme.com"
                class="font-mono text-xs"
              />
            </div>
            <div class="mt-3 flex items-center gap-3">
              <Button data-testid="import-csv" variant="secondary" onClick={importCsv} disabled={!savedId}>
                Import CSV
              </Button>
              {imported !== null ? (
                <Badge data-testid="csv-imported" tone="success">
                  Imported {imported}
                </Badge>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
}
