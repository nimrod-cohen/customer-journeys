// SegmentBuilder (§12): dynamic rule-AST builder + manual hand-pick/CSV, with a
// LIVE size preview. The AST is assembled by the pure ast-builder and previewed
// via POST /segments/preview (scoped to the active workspace server-side). Manual
// members are added by CSV emails via /segments/:id/import-csv. (Visual redesign;
// all data-testid attributes preserved.)
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import {
  buildAst,
  rowsFromAst,
  emptyRow,
  emptyEventRow,
  emptyEventCondition,
  BUILDER_OPERATORS,
  EVENT_COUNT_OPS,
  type AstNode,
  type RuleRow,
  type RuleKind,
  type EventCondition,
  type EventCountOp,
  type BuilderOperator,
  type Combinator,
} from '../segments/ast-builder.js';
import { Badge, Button, Card, Field, Input, PageHeader, Select, Textarea } from '../ui/kit.js';

/**
 * Free-text value input with autosuggest of EXISTING values for an attribute
 * field (`attributes.<key>`). Suggestions are fetched only once ≥2 chars are
 * typed and after the user pauses (debounced), to stay light. Non-attribute
 * fields just get a plain text box.
 */
function ValueAutosuggest({
  field,
  value,
  onChange,
}: {
  field: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const attrKey = field.startsWith('attributes.') ? field.slice('attributes.'.length) : '';
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

  const onInput = (v: string) => {
    onChange(v);
    if (timer.current) clearTimeout(timer.current);
    // Only an attribute field, and only after 2+ chars, debounced.
    if (!attrKey || v.trim().length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(() => {
      void api
        .get<{ values: string[] }>('/profiles/attribute-values', { query: { key: attrKey, q: v.trim() } })
        .then((r) => {
          // Don't suggest the exact value already typed.
          const vals = r.values.filter((s) => s !== v);
          setSuggestions(vals);
          setOpen(vals.length > 0);
        })
        .catch(() => {
          setSuggestions([]);
          setOpen(false);
        });
    }, 250);
  };

  return (
    <div ref={ref} class="relative">
      <Input
        data-testid="rule-value"
        class="w-40"
        placeholder="value"
        value={value}
        onInput={(e: Event) => onInput((e.target as HTMLInputElement).value)}
        onFocus={() => {
          if (suggestions.length) setOpen(true);
        }}
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
export function SegmentBuilder({ id }: { id?: string }) {
  const editing = Boolean(id);
  const [rows, setRows] = useState<RuleRow[]>([emptyRow()]);
  const [combinator, setCombinator] = useState<Combinator>('and');
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
        const { rows: r, combinator: c } = rowsFromAst(res.segment.definition);
        setRows(r);
        setCombinator(c);
      })
      .catch(() => navigate('/segments'));
  }, [id]);

  const update = (i: number, patch: Partial<RuleRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));
  // Switching kind resets the row to a clean default of that kind.
  const setKind = (i: number, kind: RuleKind) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? (kind === 'event' ? emptyEventRow() : emptyRow()) : r)));
  // Event payload ("event attribute") sub-condition editing.
  const setCond = (i: number, j: number, patch: Partial<EventCondition>) =>
    setRows((rs) =>
      rs.map((r, idx) =>
        idx === i ? { ...r, conditions: (r.conditions ?? []).map((c, k) => (k === j ? { ...c, ...patch } : c)) } : r,
      ),
    );
  const addCond = (i: number) =>
    setRows((rs) =>
      rs.map((r, idx) => (idx === i ? { ...r, conditions: [...(r.conditions ?? []), emptyEventCondition()] } : r)),
    );
  const removeCond = (i: number, j: number) =>
    setRows((rs) =>
      rs.map((r, idx) => (idx === i ? { ...r, conditions: (r.conditions ?? []).filter((_, k) => k !== j) } : r)),
    );

  const preview = async () => {
    const ast = buildAst(rows, combinator);
    const res = await api.post<{ size: number }>('/segments/preview', { body: { definition: ast } });
    setSize(res.size);
  };

  const save = async () => {
    setSaving(true);
    try {
      const ast = buildAst(rows, combinator);
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
              {rows.map((row, i) => {
                const kind: RuleKind = row.kind ?? 'field';
                return (
                  <div
                    data-testid="rule-row"
                    key={i}
                    class="rounded-xl border border-stone-200 bg-stone-50/60 p-3"
                  >
                    {/* Row header: kind selector + remove */}
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
                          onChange={(e: Event) =>
                            update(i, { operator: (e.target as HTMLSelectElement).value as BuilderOperator })
                          }
                        >
                          {BUILDER_OPERATORS.map((op) => (
                            <option key={op} value={op}>
                              {op}
                            </option>
                          ))}
                        </Select>
                        {row.operator !== 'exists' ? (
                          <ValueAutosuggest
                            field={row.field}
                            value={row.value}
                            onChange={(v) => update(i, { value: v })}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <div class="space-y-2">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="text-sm text-stone-500">did event</span>
                          <Input
                            data-testid="event-name"
                            class="min-w-[10rem] flex-1 font-mono text-xs"
                            placeholder="e.g. lead, purchase"
                            value={row.field}
                            onInput={(e: Event) => update(i, { field: (e.target as HTMLInputElement).value })}
                          />
                          <Select
                            data-testid="event-op"
                            class="w-56"
                            value={row.eventOp ?? 'occurred'}
                            onChange={(e: Event) =>
                              update(i, { eventOp: (e.target as HTMLSelectElement).value as EventCountOp })
                            }
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

                        {/* Event payload ("event attribute") filters */}
                        <div class="rounded-lg border border-stone-200 bg-white p-2.5">
                          <p class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone-500">
                            with all of these event attributes
                          </p>
                          {(row.conditions ?? []).length === 0 ? (
                            <p class="text-xs text-stone-400">No event-attribute filters.</p>
                          ) : null}
                          {(row.conditions ?? []).map((c, j) => (
                            <div data-testid="event-cond-row" key={j} class="mt-1.5 flex flex-wrap items-center gap-2">
                              <Input
                                data-testid="event-cond-field"
                                class="min-w-[8rem] flex-1 font-mono text-xs"
                                placeholder="payload key (e.g. interest)"
                                value={c.field}
                                onInput={(e: Event) => setCond(i, j, { field: (e.target as HTMLInputElement).value })}
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
                                <Input
                                  data-testid="event-cond-value"
                                  class="w-36"
                                  placeholder="value"
                                  value={c.value}
                                  onInput={(e: Event) => setCond(i, j, { value: (e.target as HTMLInputElement).value })}
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
                          <Button
                            data-testid="event-cond-add"
                            variant="ghost"
                            size="sm"
                            class="mt-1.5"
                            onClick={() => addCond(i)}
                          >
                            + Add event attribute filter
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div class="flex flex-wrap gap-2">
                <Button
                  data-testid="add-rule"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRows((rs) => [...rs, emptyRow()])}
                >
                  + Add field rule
                </Button>
                <Button
                  data-testid="add-event-rule"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRows((rs) => [...rs, emptyEventRow()])}
                >
                  + Add event rule
                </Button>
              </div>
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
