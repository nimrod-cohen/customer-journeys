// SegmentBuilder (§12): dynamic rule-AST builder + manual hand-pick/CSV, with a
// LIVE size preview. The AST is assembled by the pure ast-builder and previewed
// via POST /segments/preview (scoped to the active workspace server-side). Manual
// members are added by CSV emails via /segments/:id/import-csv.
import { useEffect, useState } from 'preact/hooks';
import { api, sessionStore } from '../store/session.js';
import { useStore } from '../store/store.js';
import {
  buildAst,
  emptyRow,
  BUILDER_OPERATORS,
  type RuleRow,
  type BuilderOperator,
  type Combinator,
} from '../segments/ast-builder.js';

interface ExistingSegment {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export function SegmentBuilder() {
  const [rows, setRows] = useState<RuleRow[]>([emptyRow()]);
  const [combinator, setCombinator] = useState<Combinator>('and');
  const [size, setSize] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [csv, setCsv] = useState('');
  const [imported, setImported] = useState<number | null>(null);

  // The list of EXISTING segments in the ACTIVE workspace. Reloads whenever the
  // active workspace changes (the switcher swaps the token), so switching A→B
  // surfaces B's segments and drops A's — letting the e2e prove no cross-bleed.
  const session = useStore(sessionStore);
  const [existing, setExisting] = useState<readonly ExistingSegment[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!session.workspaceId) {
      setExisting([]);
      return;
    }
    void api
      .get<{ segments: ExistingSegment[] }>('/segments')
      .then((res) => {
        if (!cancelled) setExisting(res.segments);
      })
      .catch(() => {
        if (!cancelled) setExisting([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session.workspaceId]);

  const update = (i: number, patch: Partial<RuleRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const preview = async () => {
    const ast = buildAst(rows, combinator);
    const res = await api.post<{ size: number }>('/segments/preview', { body: { definition: ast } });
    setSize(res.size);
  };

  const save = async () => {
    const ast = buildAst(rows, combinator);
    const res = await api.post<{ segment: { id: string } }>('/segments', {
      body: { name: name || 'Untitled segment', kind: 'dynamic_realtime', definition: ast },
    });
    setSavedId(res.segment.id);
  };

  const importCsv = async () => {
    if (!savedId) return;
    const emails = csv
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await api.post<{ added: number }>(`/segments/${savedId}/import-csv`, {
      body: { emails },
    });
    setImported(res.added);
  };

  return (
    <section data-testid="segment-builder">
      <h1>Segment builder</h1>

      <h2>Existing segments</h2>
      <ul data-testid="segment-list">
        {existing.map((s) => (
          <li data-testid="segment-list-item" data-segment-id={s.id} key={s.id}>
            {s.name}
          </li>
        ))}
      </ul>

      <input
        data-testid="segment-name"
        placeholder="Segment name"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <div>
        <label>
          Match
          <select
            data-testid="segment-combinator"
            value={combinator}
            onChange={(e) => setCombinator((e.target as HTMLSelectElement).value as Combinator)}
          >
            <option value="and">all (AND)</option>
            <option value="or">any (OR)</option>
          </select>
        </label>
      </div>
      {rows.map((row, i) => (
        <div data-testid="rule-row" key={i} style={{ margin: '6px 0' }}>
          <input
            data-testid="rule-field"
            value={row.field}
            onInput={(e) => update(i, { field: (e.target as HTMLInputElement).value })}
          />
          <select
            data-testid="rule-operator"
            value={row.operator}
            onChange={(e) =>
              update(i, { operator: (e.target as HTMLSelectElement).value as BuilderOperator })
            }
          >
            {BUILDER_OPERATORS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <input
            data-testid="rule-value"
            value={row.value}
            onInput={(e) => update(i, { value: (e.target as HTMLInputElement).value })}
          />
        </div>
      ))}
      <button data-testid="add-rule" type="button" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
        Add rule
      </button>
      <button data-testid="preview-size" type="button" onClick={preview}>
        Preview size
      </button>
      {size !== null ? <p data-testid="segment-size">Size: {size}</p> : null}
      <button data-testid="save-segment" type="button" onClick={save}>
        Save segment
      </button>
      {savedId ? <p data-testid="segment-saved">Saved {savedId}</p> : null}

      <h2>Manual members (CSV)</h2>
      <textarea
        data-testid="csv-input"
        value={csv}
        onInput={(e) => setCsv((e.target as HTMLTextAreaElement).value)}
        placeholder="comma or newline separated emails"
      />
      <button data-testid="import-csv" type="button" onClick={importCsv} disabled={!savedId}>
        Import CSV
      </button>
      {imported !== null ? <p data-testid="csv-imported">Imported: {imported}</p> : null}
    </section>
  );
}
