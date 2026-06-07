// SegmentBuilder (§12): dynamic rule-AST builder + manual hand-pick/CSV, with a
// LIVE size preview. The AST is assembled by the pure ast-builder and previewed
// via POST /segments/preview (scoped to the active workspace server-side). Manual
// members are added by CSV emails via /segments/:id/import-csv. (Visual redesign;
// all data-testid attributes preserved.)
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import {
  buildAst,
  rowsFromAst,
  emptyRow,
  BUILDER_OPERATORS,
  type AstNode,
  type RuleRow,
  type BuilderOperator,
  type Combinator,
} from '../segments/ast-builder.js';
import { Badge, Button, Card, Field, Input, PageHeader, Select, Textarea } from '../ui/kit.js';

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

            <div class="mt-5 space-y-2">
              <span class="label">Rules</span>
              {rows.map((row, i) => (
                <div
                  data-testid="rule-row"
                  key={i}
                  class="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50/60 p-2"
                >
                  <Input
                    data-testid="rule-field"
                    class="min-w-[12rem] flex-1 font-mono text-xs"
                    placeholder="features.counters.purchase_30d"
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
                  <Input
                    data-testid="rule-value"
                    class="w-32"
                    placeholder="value"
                    value={row.value}
                    onInput={(e: Event) => update(i, { value: (e.target as HTMLInputElement).value })}
                  />
                </div>
              ))}
              <Button
                data-testid="add-rule"
                variant="ghost"
                size="sm"
                onClick={() => setRows((rs) => [...rs, emptyRow()])}
              >
                + Add rule
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
