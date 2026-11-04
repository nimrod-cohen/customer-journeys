// MergeProfileDrawer (§6/§12): merge two profiles. Shows the LEAD (survivor) and
// SECONDARY (merged-in, then deleted), lets you swap them, and resolve attribute
// conflicts (which side's value migrates when a key exists in both). The server
// reassigns all events, repoints manual memberships to the survivor, recomputes
// features, and re-evaluates dynamic segments. On success the caller navigates to
// the surviving profile.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Badge, Button, Drawer, Field } from '../ui/kit.js';
import { ProfilePicker } from '../ui/ProfilePicker.js';
import { formatDateTime } from '../ui/datetime.js';

interface P {
  id: string;
  email: string | null;
  phone?: string | null;
  external_id: string | null;
  created_at?: string;
  created_at_unix?: number;
  attributes: Record<string, unknown>;
}
interface Candidate {
  id: string;
  email: string | null;
  phone?: string | null;
  external_id: string | null;
  created_at?: string;
  created_at_unix?: number;
  attributes?: Record<string, unknown>;
}

type Side = 'lead' | 'secondary';
type IdField = 'email' | 'phone';
const ID_FIELDS: IdField[] = ['email', 'phone'];

function fmt(v: unknown): string {
  if (v === undefined) return '—';
  return typeof v === 'string' ? v : JSON.stringify(v);
}
function fmtDate(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : formatDateTime(d);
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
  const [other, setOther] = useState<Candidate | null>(null);
  // `swapped` flips which of {profile, other} is the lead (survivor).
  const [swapped, setSwapped] = useState(false);
  // For attribute keys present in BOTH, which side's value wins ('lead'|'secondary').
  const [choice, setChoice] = useState<Record<string, 'lead' | 'secondary'>>({});
  // Email/phone are core fields, not attributes: picked per field, sent as `identity`.
  const [idPick, setIdPick] = useState<Partial<Record<IdField, Side>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setOther(null);
    setSwapped(false);
    setChoice({});
    setIdPick({});
    setError('');
  }, [open, profile.id]);

  // Resolve lead/secondary from the swap toggle.
  const lead: Candidate = swapped && other ? other : profile;
  const secondary: Candidate | undefined = swapped ? profile : (other ?? undefined);

  const leadAttrs = (lead.attributes ?? {}) as Record<string, unknown>;
  const secAttrs = (secondary?.attributes ?? {}) as Record<string, unknown>;
  const keys = useMemo(
    () => [...new Set([...Object.keys(leadAttrs), ...Object.keys(secAttrs)])].sort(),
    [leadAttrs, secAttrs],
  );

  // Default pick: the lead's value when it has one, else the secondary's — shown,
  // and changeable, in the Contact rows.
  const pickFor = (f: IdField): Side => idPick[f] ?? (lead[f] ? 'lead' : secondary?.[f] ? 'secondary' : 'lead');
  const keptValue = (f: IdField) => (pickFor(f) === 'lead' ? lead[f] : secondary?.[f]) ?? null;
  const noIdentifier = !!secondary && !keptValue('email') && !keptValue('phone');

  const merge = async () => {
    if (!secondary || noIdentifier) return;
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
      await api.post(`/profiles/${lead.id}/merge`, {
        body: { secondary_id: secondary.id, attributes, identity: { email: pickFor('email'), phone: pickFor('phone') } },
      });
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
      <p class="mt-2 truncate font-semibold text-ink-900">{p?.email ?? p?.phone ?? '—'}</p>
      <p class="font-mono text-xs text-stone-500">{p?.external_id ? `ext: ${p.external_id}` : 'no external id'}</p>
      <p class="mt-1 text-xs text-stone-400">Created {fmtDate(p?.created_at_unix ?? p?.created_at)}</p>
    </div>
  );

  // One value option in the conflict toggle. Selected = the value that flows into
  // the survivor (brand-filled + arrow points to it). Colour is NOT the only cue:
  // each chip is labelled lead/secondary and the selected one carries a ✓.
  const chip = (
    k: string,
    side: Side,
    value: unknown,
    pick: Side,
    onPick: (side: Side) => void = (sd) => setChoice((c) => ({ ...c, [k]: sd })),
  ) => {
    const sel = pick === side;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={sel}
        data-testid={side === 'lead' ? 'merge-pick-lead' : 'merge-pick-secondary'}
        onClick={() => onPick(side)}
        class={`min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-left transition focus:outline-none focus:ring-2 focus:ring-brand-400/40 ${
          sel
            ? 'border-brand-600 bg-brand-600 text-white shadow-glow'
            : 'border-stone-200 bg-surface text-stone-500 hover:border-stone-300'
        }`}
        title={fmt(value)}
      >
        <span class="flex items-center gap-1">
          {sel ? (
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" class="h-3 w-3 shrink-0">
              <path d="M4 10l4 4 8-9" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          ) : null}
          <span class="truncate text-sm font-medium">{value === null || value === undefined ? '—' : fmt(value)}</span>
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
          <Button data-testid="merge-confirm" variant="danger" onClick={merge} disabled={!secondary || busy || noIdentifier}>
            {busy ? 'Merging…' : 'Merge profiles'}
          </Button>
        </>
      }
    >
      <div class="space-y-4">
        <Field label="Merge with">
          <ProfilePicker
            testId="merge-secondary-select"
            value={other}
            excludeId={profile.id}
            onChange={(p) => {
              setOther(p);
              setSwapped(false);
              setChoice({});
            }}
          />
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
                onClick={() => {
                  setSwapped((v) => !v);
                  setIdPick({});
                }}
              >
                ⇄
              </Button>
              {panel(secondary, 'Secondary (deleted)', 'neutral')}
            </div>

            <div>
              <span class="label">Contact</span>
              <p class="mb-2 text-xs text-stone-400">Pick which email and phone the survivor keeps.</p>
              <div class="divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200">
                {ID_FIELDS.map((f) => {
                  const lv = lead[f] ?? null;
                  const sv = secondary[f] ?? null;
                  const pick = pickFor(f);
                  return (
                    <div data-testid="merge-identity-row" data-key={f} key={f} class="flex items-center gap-3 px-3 py-2.5">
                      <span class="w-20 shrink-0 font-mono text-xs text-stone-500">{f}</span>
                      {lv === sv ? (
                        <span class="flex-1 truncate text-right text-sm text-stone-700">{lv ?? '—'}</span>
                      ) : (
                        <div role="radiogroup" aria-label={`Choose the ${f} to keep`} class="flex min-w-0 flex-1 items-center gap-2">
                          {chip(f, 'lead', lv, pick, (sd) => setIdPick((c) => ({ ...c, [f]: sd })))}
                          <span class="grid h-8 w-8 shrink-0 place-items-center text-stone-300">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class={`h-4 w-4 transition-transform duration-200 ${pick === 'lead' ? 'rotate-180' : ''}`}>
                              <path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                          </span>
                          {chip(f, 'secondary', sv, pick, (sd) => setIdPick((c) => ({ ...c, [f]: sd })))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {noIdentifier ? (
                <p data-testid="merge-identity-error" class="mt-2 text-sm text-rose-600">
                  The merged profile needs an email or a phone.
                </p>
              ) : null}
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
