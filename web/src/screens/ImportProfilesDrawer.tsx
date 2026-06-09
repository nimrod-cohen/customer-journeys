// ImportProfilesDrawer (§7): bulk-create/update profiles from a CSV. Email is the
// identity key, so the first row must be headers including an `email` column; an
// optional `external_id` column is recognised, every other column becomes a typed
// attribute. The client parses the CSV and posts typed rows; the server upserts on
// (workspace_id, email) — new emails created, existing ones merged.
import { useMemo, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Button, Drawer } from '../ui/kit.js';

/** Minimal RFC-4180-ish CSV parser: quotes, escaped "" quotes, CRLF/LF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-empty rows (trailing newlines).
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Coerce a CSV cell to a typed value: number/boolean/JSON when it parses, else string. */
function coerce(raw: string): unknown {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v[0] === '[' || v[0] === '{') {
    try {
      return JSON.parse(v);
    } catch {
      /* fall through to string */
    }
  }
  return v;
}

interface ParsedRow {
  email: string;
  external_id?: string;
  attributes: Record<string, unknown>;
}
interface Parsed {
  headers: string[];
  emailIdx: number;
  rows: ParsedRow[];
  invalidEmails: number;
}
interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  total: number;
  errors: Array<{ row: number; email: string; error: string }>;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function ImportProfilesDrawer({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);

  const parsed = useMemo<Parsed | null>(() => {
    const grid = parseCsv(text);
    if (grid.length < 2) return null; // need header + ≥1 data row
    const headers = grid[0]!.map((h) => h.trim());
    const lower = headers.map((h) => h.toLowerCase());
    const emailIdx = lower.indexOf('email');
    if (emailIdx < 0) return { headers, emailIdx: -1, rows: [], invalidEmails: 0 };
    const extIdx = lower.findIndex((h) => h === 'external_id' || h === 'external id');
    const rows: ParsedRow[] = [];
    let invalidEmails = 0;
    for (const cells of grid.slice(1)) {
      const email = (cells[emailIdx] ?? '').trim();
      if (!EMAIL_RE.test(email)) {
        invalidEmails++;
        continue;
      }
      const attributes: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        if (i === emailIdx || i === extIdx) return;
        const val = (cells[i] ?? '').trim();
        if (val !== '' && h !== '') attributes[h] = coerce(val);
      });
      const row: ParsedRow = { email, attributes };
      if (extIdx >= 0 && (cells[extIdx] ?? '').trim()) row.external_id = cells[extIdx]!.trim();
      rows.push(row);
    }
    return { headers, emailIdx, rows, invalidEmails };
  }, [text]);

  const reset = () => {
    setText('');
    setResult(null);
    setError('');
  };

  // Offer a ready-made example so the expected shape is one click away.
  const SAMPLE_CSV =
    'email,external_id,tier,plan,lifetime_value,vip\n' +
    'jane@acme.com,CRM-001,gold,pro,1250.50,true\n' +
    'john@acme.com,,silver,,0,false\n';
  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'profiles-sample.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const onFile = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const submit = async () => {
    if (!parsed || parsed.emailIdx < 0 || parsed.rows.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post<ImportResult>('/profiles/import-csv', { body: { rows: parsed.rows } });
      setResult(r);
      onImported();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'import failed');
    } finally {
      setBusy(false);
    }
  };

  const attrCols = parsed?.emailIdx != null && parsed.emailIdx >= 0
    ? parsed.headers.filter((h, i) => i !== parsed.emailIdx && h.toLowerCase() !== 'external_id' && h.toLowerCase() !== 'external id' && h.trim() !== '')
    : [];

  return (
    <Drawer
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Import profiles (CSV)"
      subtitle="Upsert profiles by email. First row = headers, including an 'email' column; other columns become attributes."
      testId="import-drawer"
      footer={
        <>
          <Button
            data-testid="import-close"
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Close
          </Button>
          <Button
            data-testid="import-submit"
            onClick={submit}
            disabled={busy || !parsed || parsed.emailIdx < 0 || parsed.rows.length === 0}
          >
            {busy ? 'Importing…' : parsed && parsed.rows.length ? `Import ${parsed.rows.length} profiles` : 'Import'}
          </Button>
        </>
      }
    >
      <div class="space-y-4">
        <div class="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
          <p class="text-xs text-stone-500">
            First row must be headers including an <code>email</code> column.
          </p>
          <button
            data-testid="import-sample"
            type="button"
            onClick={downloadSample}
            class="shrink-0 text-xs font-medium text-brand-600 underline-offset-2 hover:underline"
          >
            Download sample CSV
          </button>
        </div>

        <div>
          <span class="label">Upload a .csv file</span>
          <input
            data-testid="import-file"
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            class="mt-1 block w-full text-sm text-stone-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
          />
        </div>

        <div>
          <span class="label">…or paste CSV</span>
          <textarea
            data-testid="import-textarea"
            class="input mt-1 h-40 w-full font-mono text-xs"
            placeholder={'email,tier,plan\njane@acme.com,vip,pro\njohn@acme.com,std,'}
            value={text}
            onInput={(e: Event) => setText((e.target as HTMLTextAreaElement).value)}
          />
        </div>

        {/* Parse preview / validation */}
        {text.trim() ? (
          parsed === null ? (
            <p data-testid="import-parse-status" class="text-sm text-stone-500">
              Add a header row and at least one data row.
            </p>
          ) : parsed.emailIdx < 0 ? (
            <p data-testid="import-parse-status" class="text-sm text-rose-600">
              No <code>email</code> column found in the header row.
            </p>
          ) : (
            <div data-testid="import-parse-status" class="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm">
              <p class="font-medium text-ink-900">
                {parsed.rows.length} {parsed.rows.length === 1 ? 'profile' : 'profiles'} ready
                {parsed.invalidEmails > 0 ? (
                  <span class="text-stone-500"> · {parsed.invalidEmails} skipped (bad email)</span>
                ) : null}
              </p>
              {attrCols.length > 0 ? (
                <p class="mt-1 text-xs text-stone-500">
                  Attributes: <span class="font-mono">{attrCols.join(', ')}</span>
                </p>
              ) : (
                <p class="mt-1 text-xs text-stone-400">No attribute columns — only email.</p>
              )}
            </div>
          )
        ) : null}

        {error ? <p data-testid="import-error" class="text-sm text-rose-600">{error}</p> : null}

        {result ? (
          <div data-testid="import-result" class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
            <p class="font-medium text-emerald-800">
              Imported: {result.created} created · {result.updated} updated
              {result.skipped > 0 ? ` · ${result.skipped} skipped` : ''}
            </p>
            {result.errors.length > 0 ? (
              <ul class="mt-2 list-disc space-y-0.5 pl-5 text-xs text-stone-600">
                {result.errors.slice(0, 10).map((er) => (
                  <li key={er.row}>
                    row {er.row} ({er.email || 'no email'}): {er.error}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
