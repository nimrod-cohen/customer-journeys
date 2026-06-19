// SegmentBuilder (§12): dynamic rule-AST builder + manual hand-pick/CSV, with a
// LIVE size preview. The AST is assembled by the pure ast-builder and previewed
// via POST /segments/preview (scoped to the active workspace server-side). Manual
// members are added by CSV emails via /segments/:id/import-csv. (Visual redesign;
// all data-testid attributes preserved.)
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate, setNavGuard } from '../router.js';
import { askConfirm } from '../ui/dialog.js';
import {
  buildAstFromGroup,
  groupFromAst,
  emptyGroup,
  emptyRow,
  emptyEventRow,
  emptyEventCondition,
  BUILDER_OPERATORS,
  EVENT_COUNT_OPS,
  isCountOp,
  type AstNode,
  type RuleRow,
  type RuleKind,
  type RuleGroup,
  type EventCondition,
  type EventCountOp,
  type EventWindow,
  type BuilderOperator,
  type Combinator,
} from '../segments/ast-builder.js';
import { resolveCustomerField } from '@cdp/shared';
import { Button, Card, Field, Input, PageHeader, Select, Textarea } from '../ui/kit.js';

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

/** Common field paths offered as suggestions for a 'field' rule. The
 *  `customer.*` namespace is the same shorthand used in email tags (§11):
 *  `customer.tier` ≡ `attributes.tier`, `customer.email` ≡ `email`. */
const FIELD_SUGGESTIONS = [
  'email_status',
  'total_events',
  'monetary_total',
  'last_event_at',
  'customer.tier',
  'customer.source',
  'attributes.tier',
  'features.counters.purchase_30d',
];
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
 * SegmentBuilder is the DESIGNATED create/edit screen. With no `id` it creates a
 * new segment (/segments/new); with an `id` it loads that segment and edits it
 * (/segments/:id). Saving routes back to the list, which re-fetches → reactive.
 */
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
                <Input
                  data-testid="rule-field"
                  list="field-suggestions"
                  class="min-w-[12rem] flex-1 font-mono text-xs"
                  placeholder="customer.tier, email_status, features.counters.purchase_30d…"
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

export function SegmentBuilder({ id }: { id?: string }) {
  const editing = Boolean(id);
  // The root group: its own combinator + rules, plus optional sub-groups (2-level
  // hierarchy). Root rules and sub-groups are combined by `combinator`.
  const [rows, setRows] = useState<RuleRow[]>([emptyRow()]);
  const [combinator, setCombinator] = useState<Combinator>('and');
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [size, setSize] = useState<number | null>(null);
  // Live members preview (dynamic segments): one page of 50 at `offset`.
  const [members, setMembers] = useState<Array<{ id: string; email: string | null }>>([]);
  const [offset, setOffset] = useState(0);
  // The members panel reflects the SAVED segment — it refreshes on entry and on
  // save, NOT on every edit. `memVersion` bumps to trigger a (re)load; `dirty`
  // marks unsaved rule edits so we can flag the list as stale.
  const [memVersion, setMemVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  // A compile/preview error from the server (e.g. an unrecognized rule field) —
  // surfaced in the members panel instead of silently showing 0 members.
  const [previewError, setPreviewError] = useState('');
  const PAGE = 50;
  const [name, setName] = useState('');
  // A segment is EITHER dynamic (rule-based) OR manual (uploaded list) — never
  // both. Chosen on create; fixed thereafter.
  const [segmentKind, setSegmentKind] = useState<'dynamic_realtime' | 'manual'>('dynamic_realtime');
  const [savedId, setSavedId] = useState<string | null>(id ?? null);
  const [saving, setSaving] = useState(false);
  const [csv, setCsv] = useState('');

  // Edit mode: load the existing segment, set its type, and hydrate the editor.
  useEffect(() => {
    if (!id) return;
    void api
      .get<{ segment: { name: string; kind: string; definition: AstNode | null } }>(`/segments/${id}`)
      .then((res) => {
        setName(res.segment.name);
        setSegmentKind(res.segment.kind === 'manual' ? 'manual' : 'dynamic_realtime');
        const g = groupFromAst(res.segment.definition);
        setRows(g.rows);
        setCombinator(g.combinator);
        setGroups(g.groups);
        setMemVersion((v) => v + 1); // load the saved segment's members on entry
      })
      .catch(() => navigate('/segments'));
  }, [id]);

  // The whole audience as one root group (root rules + sub-groups).
  const rootGroup = (): RuleGroup => ({ combinator, rows, groups });
  const updateGroup = (gi: number, patch: Partial<RuleGroup>) =>
    setGroups((gs) => gs.map((g, idx) => (idx === gi ? { ...g, ...patch } : g)));
  const removeGroup = (gi: number) => setGroups((gs) => gs.filter((_, idx) => idx !== gi));

  // Load one page (50) of the matching members + the total count.
  // Load one page (50) of members + the total count. Dynamic → live rule preview;
  // manual → the segment's CURRENT materialized members (once it exists).
  const loadMembers = async (off: number) => {
    setPreviewError('');
    try {
      if (segmentKind === 'manual') {
        if (!savedId) {
          setSize(0);
          setMembers([]);
          setOffset(0);
          setDirty(false);
          return;
        }
        const res = await api.get<{ size: number; members: Array<{ id: string; email: string | null }> }>(
          `/segments/${savedId}/members?offset=${off}`,
        );
        setSize(res.size);
        setMembers(res.members);
        setOffset(off);
        setDirty(false);
        return;
      }
      const ast = buildAstFromGroup({ combinator, rows, groups });
      // No rules → an inactive DRAFT. Don't preview (a null AST would match everyone).
      if (ast === null) {
        setSize(0);
        setMembers([]);
        setOffset(0);
        setDirty(false);
        return;
      }
      const res = await api.post<{ size: number; members: Array<{ id: string; email: string | null }> }>(
        '/segments/preview',
        { body: { definition: ast, offset: off } },
      );
      setSize(res.size);
      setMembers(res.members);
      setOffset(off);
      setDirty(false);
    } catch (e) {
      // A compile error (e.g. an unrecognized field) — surface it rather than
      // silently showing an empty list.
      setPreviewError((e as { error?: string })?.error ?? 'Could not evaluate this segment’s rules.');
      setSize(null);
      setMembers([]);
      setDirty(false);
    }
  };

  // Refresh the members panel ONLY on entry (after hydrate) and after a save —
  // never on every keystroke. `memVersion` is bumped in those two places.
  useEffect(() => {
    if (memVersion === 0) return; // nothing to show until the segment exists / is saved
    void loadMembers(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memVersion]);

  // Editing the rules/name marks the editor dirty (members list stale until the
  // next save, and gates leaving the screen). Skip the initial mount run so an
  // untouched segment — or the post-hydrate state restore in edit mode — isn't
  // falsely flagged; only genuine edits set it.
  const seededDirty = useRef(false);
  useEffect(() => {
    if (!seededDirty.current) {
      seededDirty.current = true;
      return;
    }
    setDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, combinator, groups, csv, name]);

  // Block leaving the screen with unsaved changes. `dirtyRef` mirrors `dirty` so
  // the guard/beforeunload closures aren't stale. The nav guard (in-app links,
  // back button, browser back/forward) asks for confirmation; beforeunload covers
  // refresh/tab-close (native browser prompt — can't be styled).
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    setNavGuard(async () =>
      dirtyRef.current
        ? askConfirm({
            title: 'Discard changes?',
            message: 'You have unsaved changes to this segment. Leave without saving?',
            danger: true,
            confirmLabel: 'Discard',
          })
        : true,
    );
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    globalThis.addEventListener?.('beforeunload', onBeforeUnload);
    return () => {
      setNavGuard(null);
      globalThis.removeEventListener?.('beforeunload', onBeforeUnload);
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      // A successful save clears the unsaved-changes flag synchronously — the
      // members panel reloads (loadMembers) asynchronously, but the leave-guard
      // must release the moment the save lands, not after the preview fetch.
      const segName = name || 'Untitled segment';
      if (segmentKind === 'manual') {
        // Manual: create (or update) the segment, then import the pasted emails.
        const emails = csv
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean);
        let sid = savedId;
        if (sid) {
          await api.put(`/segments/${sid}`, { body: { name: segName } });
        } else {
          const res = await api.post<{ segment: { id: string } }>('/segments', {
            body: { name: segName, kind: 'manual', definition: null },
          });
          sid = res.segment.id;
          setSavedId(sid);
        }
        if (sid && emails.length) {
          await api.post(`/segments/${sid}/import-csv`, { body: { emails } });
          setCsv(''); // imported — clear the box (members panel now reflects them)
        }
        setDirty(false);
        setMemVersion((v) => v + 1); // refresh the members panel in place
        return;
      }
      // Dynamic: compile the rule group into the §8 AST.
      const ast = buildAstFromGroup(rootGroup());
      if (savedId) {
        await api.put(`/segments/${savedId}`, { body: { name: segName, definition: ast } });
      } else {
        const res = await api.post<{ segment: { id: string } }>('/segments', {
          body: { name: segName, kind: 'dynamic_realtime', definition: ast },
        });
        setSavedId(res.segment.id);
      }
      setDirty(false);
      setMemVersion((v) => v + 1); // refresh the members panel in place
    } finally {
      setSaving(false);
    }
  };

  // A dynamic segment with no rules is an inactive draft (matches no one until a
  // rule is added).
  const isDraft = segmentKind === 'dynamic_realtime' && buildAstFromGroup({ combinator, rows, groups }) === null;

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

      <div class="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* LEFT: the builder */}
        <div class="min-w-0 flex-1">
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
              <Field label="Type">
                {editing ? (
                  <span data-testid="segment-type" class="inline-block py-2 text-sm font-medium capitalize text-stone-700">
                    {segmentKind === 'manual' ? 'Manual (uploaded list)' : 'Dynamic (rule-based)'}
                  </span>
                ) : (
                  <Select
                    data-testid="segment-type"
                    value={segmentKind}
                    onChange={(e: Event) =>
                      setSegmentKind((e.target as HTMLSelectElement).value as 'dynamic_realtime' | 'manual')
                    }
                  >
                    <option value="dynamic_realtime">Dynamic (rule-based)</option>
                    <option value="manual">Manual (uploaded list)</option>
                  </Select>
                )}
              </Field>
              {segmentKind === 'dynamic_realtime' ? (
                <Field label="Match">
                  <Select
                    data-testid="segment-combinator"
                    value={combinator}
                    onChange={(e: Event) => setCombinator((e.target as HTMLSelectElement).value as Combinator)}
                  >
                    <option value="and">all (AND)</option>
                    <option value="or">any (OR)</option>
                  </Select>
                </Field>
              ) : null}
            </div>

            {segmentKind === 'dynamic_realtime' ? (
            <>
            <datalist id="field-suggestions">
              {FIELD_SUGGESTIONS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>

            <div class="mt-5 space-y-3">
              <span class="label">Rules</span>
              <RuleListEditor rows={rows} onChange={setRows} allowEmpty />

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
            </>
            ) : (
              /* Manual: a hand-curated list uploaded as CSV. */
              <div class="mt-5 space-y-3">
                <span class="label">Add members (CSV)</span>
                <p class="text-sm text-stone-500">
                  Paste comma- or newline-separated emails. Matching profiles in this workspace
                  become members; saving creates the segment and imports them.
                </p>
                <Textarea
                  data-testid="csv-input"
                  value={csv}
                  onInput={(e: Event) => setCsv((e.target as HTMLTextAreaElement).value)}
                  placeholder="alice@acme.com, bob@acme.com"
                  class="font-mono text-xs"
                />
              </div>
            )}

            <div class="mt-5 flex items-center gap-3 border-t border-stone-100 pt-4">
              <Button data-testid="save-segment" onClick={save} disabled={saving}>
                {saving
                  ? 'Saving…'
                  : editing
                    ? isDraft
                      ? 'Save draft'
                      : 'Save changes'
                    : isDraft
                      ? 'Save draft'
                      : segmentKind === 'manual'
                        ? 'Create segment'
                        : 'Save segment'}
              </Button>
            </div>
          </Card>
        </div>

        {/* RIGHT: live members (both types) */}
        <div class="w-full lg:w-80 lg:shrink-0">
          <Card data-testid="members-panel" class="p-5 lg:sticky lg:top-4">
            <div class="flex items-center justify-between">
              <span class="label">Members</span>
              <span data-testid="segment-size" class="text-sm font-medium text-stone-600">
                {isDraft
                  ? 'Draft'
                  : size === null
                    ? '—'
                    : segmentKind === 'manual'
                      ? `${size} member${size === 1 ? '' : 's'}`
                      : `${size} matching`}
              </span>
            </div>
            {previewError ? (
              <p
                data-testid="segment-preview-error"
                class="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200"
              >
                {previewError}
              </p>
            ) : isDraft ? (
              <p data-testid="segment-draft-note" class="mt-2 text-sm text-amber-600">
                No rules yet — this segment is an inactive <b>draft</b> and matches no one until you add a rule.
              </p>
            ) : size === null ? (
              <p class="mt-2 text-sm text-stone-400">The member list refreshes when you save.</p>
            ) : (
              <>
                {dirty ? (
                  <p data-testid="members-stale" class="mt-2 text-xs text-amber-600">
                    Unsaved edits — save to refresh this list.
                  </p>
                ) : null}
                {members.length === 0 ? (
                  <p class="mt-2 text-sm text-stone-400">
                    {segmentKind === 'manual' ? 'No members yet — paste emails and save.' : 'No matching profiles.'}
                  </p>
                ) : (
                  <>
                    <ul class="mt-3 divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200">
                      {members.map((m) => (
                        <li
                          data-testid="member-preview-row"
                          key={m.id}
                          class="truncate px-3 py-1.5 text-sm text-ink-800"
                          title={m.email ?? m.id}
                        >
                          {m.email ?? m.id}
                        </li>
                      ))}
                    </ul>
                    {size > PAGE ? (
                      <div class="mt-2 flex items-center justify-between gap-2 text-sm text-stone-500">
                        <Button
                          data-testid="members-prev"
                          variant="ghost"
                          size="sm"
                          disabled={offset === 0}
                          onClick={() => loadMembers(Math.max(0, offset - PAGE))}
                        >
                          ← Prev
                        </Button>
                        <span data-testid="members-range" class="text-xs">
                          {offset + 1}–{Math.min(offset + PAGE, size)} of {size}
                        </span>
                        <Button
                          data-testid="members-next"
                          variant="ghost"
                          size="sm"
                          disabled={offset + PAGE >= size}
                          onClick={() => loadMembers(offset + PAGE)}
                        >
                          Next →
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
    </section>
  );
}
