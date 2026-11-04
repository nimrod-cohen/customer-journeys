// A searchable profile combobox: type to search the workspace's profiles on the
// server (email / phone / external id, debounced), pick one from the dropdown.
// Keyboard: ↑/↓ to move, Enter to pick, Esc to close. Once a profile is picked the
// input shows it with a clear (×) button to search again.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../store/session.js';

export interface PickedProfile {
  id: string;
  email: string | null;
  phone?: string | null;
  external_id: string | null;
  created_at?: string;
  created_at_unix?: number;
  attributes?: Record<string, unknown>;
}

const LIMIT = 20;

function primaryLabel(p: PickedProfile): string {
  return p.email ?? p.phone ?? p.external_id ?? p.id;
}
function secondaryLabel(p: PickedProfile): string {
  return [p.email ? p.phone : null, p.external_id ? `ext: ${p.external_id}` : null].filter(Boolean).join(' · ');
}

export function ProfilePicker({
  value,
  onChange,
  excludeId,
  placeholder = 'Search by email, phone or external id…',
  testId,
}: {
  value: PickedProfile | null;
  onChange: (p: PickedProfile | null) => void;
  excludeId?: string;
  placeholder?: string;
  testId: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PickedProfile[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  // Debounced server search while the dropdown is open. A sequence number drops
  // responses that arrive after a newer query.
  useEffect(() => {
    if (!open || value) return;
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      const query: Record<string, string> = { page: '1', limit: String(LIMIT) };
      if (q.trim()) query.q = q.trim();
      api
        .get<{ profiles: PickedProfile[] }>('/profiles', { query })
        .then((r) => {
          if (mine !== seq.current) return;
          setResults(r.profiles.filter((p) => p.id !== excludeId));
          setActive(0);
        })
        .catch(() => mine === seq.current && setResults([]))
        .finally(() => mine === seq.current && setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, value, excludeId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (p: PickedProfile) => {
    onChange(p);
    setOpen(false);
    setQ('');
  };
  const clear = () => {
    onChange(null);
    setQ('');
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && results[active]) {
        e.preventDefault();
        pick(results[active]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={ref} class="relative">
      <div class="relative">
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
        >
          <circle cx="9" cy="9" r="6" />
          <path d="M14 14l4 4" stroke-linecap="round" />
        </svg>
        <input
          ref={inputRef}
          data-testid={testId}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          class="input w-full pl-9 pr-9"
          placeholder={placeholder}
          value={value ? primaryLabel(value) : q}
          readOnly={!!value}
          onFocus={() => !value && setOpen(true)}
          onClick={() => !value && setOpen(true)}
          onInput={(e: Event) => {
            setQ((e.target as HTMLInputElement).value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {value ? (
          <button
            type="button"
            data-testid={`${testId}-clear`}
            aria-label="Clear selection"
            onClick={clear}
            class="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-ink-900"
          >
            ×
          </button>
        ) : loading && open ? (
          <span class="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-stone-300 border-t-brand-600" />
        ) : null}
      </div>
      {open && !value ? (
        <div
          role="listbox"
          data-testid={`${testId}-options`}
          class="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-stone-200 bg-surface p-1 shadow-soft"
        >
          {results.length === 0 ? (
            <p class="px-3 py-2 text-sm text-stone-400">{loading ? 'Searching…' : 'No matching profiles.'}</p>
          ) : (
            results.map((p, i) => {
              const sub = secondaryLabel(p);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-testid={`${testId}-option`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(p)}
                  class={`block w-full rounded px-3 py-1.5 text-left ${i === active ? 'bg-stone-100' : ''}`}
                >
                  <span class="block truncate text-sm text-ink-900">{primaryLabel(p)}</span>
                  {sub ? <span class="block truncate text-xs text-stone-500">{sub}</span> : null}
                </button>
              );
            })
          )}
          {results.length === LIMIT ? (
            <p class="px-3 py-1.5 text-xs text-stone-400">Showing the first {LIMIT} — type to narrow.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
