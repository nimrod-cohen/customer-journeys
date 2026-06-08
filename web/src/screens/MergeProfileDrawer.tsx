// MergeProfileDrawer (§6/§12): merge two profiles. Shows the LEAD (survivor) and
// SECONDARY (merged-in, then deleted), lets you swap them, and resolve attribute
// conflicts (which side's value migrates when a key exists in both). The server
// reassigns all events, repoints manual memberships to the survivor, recomputes
// features, and re-evaluates dynamic segments. On success the caller navigates to
// the surviving profile.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Badge, Button, Drawer, Field, Select } from '../ui/kit.js';

interface P {
  id: string;
  email: string | null;
  external_id: string | null;
  attributes: Record<string, unknown>;
}
interface Candidate {
  id: string;
  email: string | null;
  external_id: string | null;
  attributes?: Record<string, unknown>;
}

function fmt(v: unknown): string {
  if (v === undefined) return '—';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function MergeProfileDrawer({
  open,
  profile,
  onClose,
  onMerged,
}: {
  open: boolean;
  profile: P;
  onClose: () => void;
  onMerged: (survivingId: string) => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [otherId, setOtherId] = useState('');
  // `swapped` flips which of {profile, other} is the lead (survivor).
  const [swapped, setSwapped] = useState(false);
  // For attribute keys present in BOTH, which side's value wins ('lead'|'secondary').
  const [choice, setChoice] = useState<Record<string, 'lead' | 'secondary'>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setOtherId('');
    setSwapped(false);
    setChoice({});
    setError('');
    void api
      .get<{ profiles: Candidate[] }>('/profiles')
      .then((r) => setCandidates(r.profiles.filter((c) => c.id !== profile.id)));
  }, [open, profile.id]);

  const other = candidates.find((c) => c.id === otherId);
  // Resolve lead/secondary from the swap toggle.
  const lead: Candidate = swapped && other ? other : profile;
  const secondary: Candidate | undefined = swapped ? profile : other;

  const leadAttrs = (lead.attributes ?? {}) as Record<string, unknown>;
  const secAttrs = (secondary?.attributes ?? {}) as Record<string, unknown>;
  const keys = useMemo(
    () => [...new Set([...Object.keys(leadAttrs), ...Object.keys(secAttrs)])].sort(),
    [leadAttrs, secAttrs],
  );

  const merge = async () => {
    if (!secondary) return;
    setBusy(true);
    setError('');
    // Build the resolved attribute object: conflicts use the chosen side; keys
    // present in only one side migrate from that side.
    const attributes: Record<string, unknown> = {};
    for (const k of keys) {
      const inLead = k in leadAttrs;
      const inSec = k in secAttrs;
      if (inLead && inSec) attributes[k] = (choice[k] ?? 'lead') === 'secondary' ? secAttrs[k] : leadAttrs[k];
      else attributes[k] = inSec ? secAttrs[k] : leadAttrs[k];
    }
    try {
      await api.post(`/profiles/${lead.id}/merge`, { body: { secondary_id: secondary.id, attributes } });
      onMerged(lead.id);
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'merge failed');
    } finally {
      setBusy(false);
    }
  };

  const panel = (p: Candidate | undefined, label: string, tone: 'success' | 'neutral') => (
    <div class="flex-1 rounded-lg border border-stone-200 p-3">
      <Badge tone={tone}>{label}</Badge>
      <p class="mt-2 truncate font-semibold text-ink-900">{p?.email ?? '—'}</p>
      <p class="font-mono text-xs text-stone-500">{p?.external_id ? `ext: ${p.external_id}` : 'no external id'}</p>
    </div>
  );

  // One value option in the conflict toggle. Selected = the value that flows into
  // the survivor (brand-filled + arrow points to it). Colour is NOT the only cue:
  // each chip is labelled lead/secondary and the selected one carries a ✓.
  const chip = (k: string, side: 'lead' | 'secondary', value: unknown, pick: 'lead' | 'secondary') => {
    const sel = pick === side;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={sel}
        data-testid={side === 'lead' ? 'merge-pick-lead' : 'merge-pick-secondary'}
        onClick={() => setChoice((c) => ({ ...c, [k]: side }))}
        class={`min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-left transition focus:outline-none focus:ring-2 focus:ring-brand-400/40 ${
          sel
            ? 'border-brand-600 bg-brand-600 text-white shadow-glow'
            : 'border-stone-200 bg-white text-stone-500 hover:border-stone-300'
        }`}
        title={fmt(value)}
      >
        <span class="flex items-center gap-1">
          {sel ? (
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" class="h-3 w-3 shrink-0">
              <path d="M4 10l4 4 8-9" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          ) : null}
          <span class="truncate text-sm font-medium">{fmt(value)}</span>
        </span>
        <span class={`block text-[10px] uppercase tracking-wide ${sel ? 'text-white/70' : 'text-stone-400'}`}>
          {side}
        </span>
      </button>
    );
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Merge profiles"
      subtitle="Combine two profiles into one survivor. Events and memberships move to the survivor; the other is deleted."
      testId="merge-drawer"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button data-testid="merge-confirm" variant="danger" onClick={merge} disabled={!secondary || busy}>
            {busy ? 'Merging…' : 'Merge profiles'}
          </Button>
        </>
      }
    >
      <div class="space-y-4">
        <Field label="Merge with">
          <Select
            data-testid="merge-secondary-select"
            value={otherId}
            onChange={(e: Event) => setOtherId((e.target as HTMLSelectElement).value)}
          >
            <option value="">Choose a profile…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.email ?? c.external_id ?? c.id}
              </option>
            ))}
          </Select>
        </Field>

        {secondary ? (
          <>
            <div class="flex items-center gap-2">
              {panel(lead, 'Lead (survivor)', 'success')}
              <Button
                data-testid="merge-swap"
                variant="ghost"
                size="sm"
                aria-label="Swap lead and secondary"
                onClick={() => setSwapped((v) => !v)}
              >
                ⇄
              </Button>
              {panel(secondary, 'Secondary (deleted)', 'neutral')}
            </div>

            <div>
              <span class="label">Attributes</span>
              <p class="mb-2 text-xs text-stone-400">
                For attributes in both profiles, pick which value the survivor keeps.
              </p>
              <div class="divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200">
                {keys.length === 0 ? <p class="px-3 py-2.5 text-sm text-stone-400">No attributes.</p> : null}
                {keys.map((k) => {
                  const inBoth = k in leadAttrs && k in secAttrs;
                  const conflict = inBoth && JSON.stringify(leadAttrs[k]) !== JSON.stringify(secAttrs[k]);
                  const pick = choice[k] ?? 'lead';
                  return (
                    <div data-testid="merge-attr-row" data-key={k} key={k} class="flex items-center gap-3 px-3 py-2.5">
                      <span class="w-20 shrink-0 truncate font-mono text-xs text-stone-500" title={k}>
                        {k}
                      </span>
                      {conflict ? (
                        <div
                          role="radiogroup"
                          aria-label={`Choose the ${k} value to keep`}
                          class="flex min-w-0 flex-1 items-center gap-2"
                        >
                          {chip(k, 'lead', leadAttrs[k], pick)}
                          <button
                            type="button"
                            data-testid="merge-flip"
                            aria-label={`Keep the ${pick} value for ${k} — click to flip`}
                            onClick={() =>
                              setChoice((c) => ({ ...c, [k]: (c[k] ?? 'lead') === 'lead' ? 'secondary' : 'lead' }))
                            }
                            class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-ink-900"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              class={`h-4 w-4 transition-transform duration-200 ${pick === 'lead' ? 'rotate-180' : ''}`}
                            >
                              <path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                          </button>
                          {chip(k, 'secondary', secAttrs[k], pick)}
                        </div>
                      ) : (
                        <div class="flex min-w-0 flex-1 items-center justify-end gap-2 text-sm text-stone-700">
                          <span class="truncate">{fmt(k in leadAttrs ? leadAttrs[k] : secAttrs[k])}</span>
                          {!inBoth ? (
                            <span class="shrink-0 text-[10px] uppercase tracking-wide text-stone-400">
                              {k in secAttrs ? 'from secondary' : 'lead only'}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {error ? <p data-testid="merge-error" class="text-sm text-rose-600">{error}</p> : null}
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
