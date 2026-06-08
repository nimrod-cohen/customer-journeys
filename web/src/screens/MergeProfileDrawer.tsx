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
              <div class="overflow-hidden rounded-lg border border-stone-200">
                <table class="w-full text-sm">
                  <tbody class="divide-y divide-stone-100">
                    {keys.length === 0 ? (
                      <tr>
                        <td class="px-3 py-2 text-stone-400">No attributes.</td>
                      </tr>
                    ) : null}
                    {keys.map((k) => {
                      const inBoth = k in leadAttrs && k in secAttrs;
                      const conflict = inBoth && JSON.stringify(leadAttrs[k]) !== JSON.stringify(secAttrs[k]);
                      const pick = choice[k] ?? 'lead';
                      return (
                        <tr data-testid="merge-attr-row" data-key={k} key={k} class="align-top">
                          <td class="px-3 py-2 font-mono text-xs text-ink-900">{k}</td>
                          {conflict ? (
                            <td class="px-3 py-2">
                              <div class="flex flex-col gap-1">
                                <label class="flex items-center gap-2">
                                  <input
                                    data-testid="merge-pick-lead"
                                    type="radio"
                                    name={`attr-${k}`}
                                    checked={pick === 'lead'}
                                    onChange={() => setChoice((c) => ({ ...c, [k]: 'lead' }))}
                                  />
                                  <span class="truncate">{fmt(leadAttrs[k])}</span>
                                  <span class="text-[10px] uppercase text-stone-400">lead</span>
                                </label>
                                <label class="flex items-center gap-2">
                                  <input
                                    data-testid="merge-pick-secondary"
                                    type="radio"
                                    name={`attr-${k}`}
                                    checked={pick === 'secondary'}
                                    onChange={() => setChoice((c) => ({ ...c, [k]: 'secondary' }))}
                                  />
                                  <span class="truncate">{fmt(secAttrs[k])}</span>
                                  <span class="text-[10px] uppercase text-stone-400">secondary</span>
                                </label>
                              </div>
                            </td>
                          ) : (
                            <td class="px-3 py-2 text-stone-700">
                              {fmt(k in leadAttrs ? leadAttrs[k] : secAttrs[k])}
                              {!inBoth ? (
                                <span class="ml-2 text-[10px] uppercase text-stone-400">
                                  {k in secAttrs ? 'from secondary' : 'lead only'}
                                </span>
                              ) : null}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {error ? <p data-testid="merge-error" class="text-sm text-rose-600">{error}</p> : null}
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
