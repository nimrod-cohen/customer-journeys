// A free-text input with an autosuggest DROPDOWN of existing values (workspace
// vocabulary). Suggestions appear on focus and filter as you type (debounced
// 250ms so we only fetch on a pause); click a suggestion to fill the field;
// click-outside closes. A null fetcher makes it a plain text box. Extracted from
// the segment RuleBuilder so the campaign trigger editor reuses the SAME combobox
// (one autocomplete UX everywhere).
import { useEffect, useRef, useState } from 'preact/hooks';
import { Input } from './kit.js';

/** Returns the existing distinct values matching `q` (workspace-scoped, capped server-side). */
export type Fetcher = ((q: string) => Promise<string[]>) | null;

export function Suggest({
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
