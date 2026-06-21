// Pretty-print JSON for read-only display (profile event payloads, activity-log
// detail). PURE formatting helpers + two small presentational components. A value
// may be an object/array OR a JSON string (we parse it first); a plain non-JSON
// string is shown verbatim.
import { useState } from 'preact/hooks';

/** Parse a JSON string to a value; return undefined if it isn't an object/array. */
export function parseJsonObjectOrArray(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    const v = JSON.parse(t);
    return v !== null && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Indented JSON for a value (or a JSON string). A plain string is returned as-is. */
export function prettyJson(value: unknown): string {
  let v = value;
  if (typeof v === 'string') {
    const parsed = parseJsonObjectOrArray(v);
    if (parsed === undefined) return v; // plain text, not JSON
    v = parsed;
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(value);
  }
}

/** A scrollable, wrapping, pretty-printed JSON block. */
export function JsonView({ value, class: cls = '' }: { value: unknown; class?: string }) {
  return (
    <pre
      data-testid="json-view"
      class={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-600 ring-1 ring-inset ring-stone-100 ${cls}`}
    >
      {prettyJson(value)}
    </pre>
  );
}

/**
 * Compact JSON for a table cell: a truncated one-line preview that EXPANDS to a
 * pretty block on click. A non-JSON string shows as plain truncated text.
 */
export function CollapsibleJson({ value }: { value: string | null }) {
  const [open, setOpen] = useState(false);
  if (!value) return <span class="text-stone-400">—</span>;
  const parsed = parseJsonObjectOrArray(value);
  if (parsed === undefined) {
    return (
      <span class="block max-w-[20rem] truncate" title={value}>
        {value}
      </span>
    );
  }
  return (
    <div class="max-w-[24rem]">
      <button
        type="button"
        data-testid="json-toggle"
        onClick={() => setOpen((o) => !o)}
        class="flex w-full items-center gap-1 text-left text-stone-500 hover:text-ink-900"
      >
        <span class={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span class="truncate">{open ? 'Hide' : value}</span>
      </button>
      {open ? <JsonView value={parsed} class="mt-1" /> : null}
    </div>
  );
}
