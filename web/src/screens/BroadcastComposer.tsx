// Broadcasts (§12, §9A): a LIST screen + a multi-step creation/edit WIZARD.
// - BroadcastComposer (/broadcasts): all broadcasts; "New broadcast" → the wizard;
//   draft/scheduled rows can be edited or sent; sent/sending rows are read-only.
// - BroadcastWizard (/broadcasts/new, /broadcasts/:id): Audience → Content →
//   Schedule. Editing is allowed only while draft or scheduled.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { setEditorReturn, takeReturnedTemplate } from '../store/editorReturn.js';
import { Badge, Button, Card, Field, Input, PageHeader, Select, EmptyState, toneFor } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';

interface Segment {
  id: string;
  name: string;
}
interface Template {
  id: string;
  name: string;
}
interface BroadcastStats {
  sent: number;
  delivered: number;
  failed: number;
  clicked: number;
}
interface Broadcast {
  id: string;
  name: string;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  updated_at: string | null;
  stats?: BroadcastStats;
}

const EDITABLE = new Set(['draft', 'scheduled']);

/** "today at 8:15 AM" / "tomorrow at 10:45 AM" / "Jun 7 at 8:22 PM" + the tz abbr. */
function whenLabel(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day0 = (x: Date) => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86_400_000);
  const diff = day0(d) - day0(new Date());
  const rel = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff === -1 ? 'yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const tz = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${rel} at ${time}${tz ? ` (${tz})` : ''}`;
}

/** "a day ago" / "3 hours ago" via Intl.RelativeTimeFormat. */
function agoLabel(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const secs = Math.round((d.getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3_600], ['minute', 60],
  ];
  for (const [unit, s] of units) {
    if (Math.abs(secs) >= s || unit === 'minute') return rtf.format(Math.round(secs / s), unit);
  }
  return 'just now';
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

function fmtDate(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

// --- List screen ------------------------------------------------------------

export function BroadcastComposer() {
  const [broadcasts, setBroadcasts] = useState<Broadcast[] | null>(null);
  // Sending is refused server-side (409) unless the workspace has a verified
  // sending domain. We learn this up front so we can warn + disable Send rather
  // than letting the user click into the refusal. null = not yet known.
  const [hasVerifiedDomain, setHasVerifiedDomain] = useState<boolean | null>(null);

  const reload = async () => {
    const b = await api.get<{ broadcasts: Broadcast[] }>('/broadcasts');
    setBroadcasts(b.broadcasts);
  };
  useEffect(() => {
    void reload();
    void api
      .get<{ domains: Array<{ verified: boolean }> }>('/sending-domains')
      .then((r) => setHasVerifiedDomain(r.domains.some((d) => d.verified)))
      .catch(() => setHasVerifiedDomain(true)); // don't block on a fetch error — the server still gates
  }, []);

  const send = async (id: string) => {
    try {
      const res = await api.post<{ result: { result?: string } }>(`/broadcasts/${id}/send`, {});
      const outcome = res.result?.result ?? 'queued';
      showToast(`Broadcast ${outcome}.`, { tone: 'success' });
      await reload();
    } catch (e) {
      // e.g. 409 when the workspace has no verified sending domain.
      showToast((e as { error?: string })?.error ?? 'Could not send the broadcast.', { tone: 'error' });
    }
  };

  // Don't disable Send while we're still discovering the domain state (null) —
  // only once we KNOW there's no verified domain.
  const blockSend = hasVerifiedDomain === false;

  return (
    <section data-testid="broadcast-composer">
      <PageHeader
        title="Broadcasts"
        subtitle="Send a one-off email to a segment or manual group."
        actions={
          <span class="flex items-center gap-2">
            <Button data-testid="design-email" variant="secondary" onClick={() => navigate('/editor')}>
              Design email
            </Button>
            <Button data-testid="new-broadcast" onClick={() => navigate('/broadcasts/new')}>
              New broadcast
            </Button>
          </span>
        }
      />

      {blockSend ? (
        <div
          data-testid="no-domain-banner"
          role="alert"
          class="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <svg viewBox="0 0 20 20" fill="none" class="mt-0.5 h-5 w-5 shrink-0 text-amber-600" stroke="currentColor" stroke-width="2">
            <path d="M10 2 1.5 17h17L10 2Z" stroke-linejoin="round" />
            <path d="M10 8v4M10 14.5h.01" stroke-linecap="round" />
          </svg>
          <span class="min-w-0 flex-1">
            No verified sending domain — broadcasts can’t be sent yet. Verify one in Workspace settings → Sending domains.
          </span>
          <button
            type="button"
            data-testid="no-domain-open-settings"
            class="shrink-0 rounded-lg border border-amber-400 px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            onClick={() => navigate('/settings/domains')}
          >
            Open settings →
          </button>
        </div>
      ) : null}

      {broadcasts === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : broadcasts.length ? (
        <ul data-testid="broadcast-list" class="space-y-2">
          {broadcasts.map((b) => {
            const editable = EDITABLE.has(b.status);
            const subtitle =
              b.status === 'scheduled' && b.scheduled_at
                ? `Scheduled to send ${whenLabel(b.scheduled_at)}`
                : b.status === 'sent' && b.sent_at
                  ? `Sent ${whenLabel(b.sent_at)}`
                  : b.status === 'sending'
                    ? 'Sending…'
                    : 'Draft — not scheduled';
            const s = b.stats;
            return (
              <li
                data-testid="broadcast-item"
                key={b.id}
                // Fixed grid columns so the status badge and the right-hand slot
                // line up across rows (icon · name/1fr · status · right slot).
                class="grid grid-cols-[auto_minmax(0,1fr)_8rem_17rem] items-center gap-4 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card"
              >
                {/* Icon */}
                <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5 shrink-0 self-start text-stone-400" stroke="currentColor" stroke-width="1.8">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m4 7 8 6 8-6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>

                {/* Name + subtitle + edited */}
                <span class="flex min-w-0 flex-col">
                  <a
                    data-testid="broadcast-open"
                    class="cursor-pointer truncate font-semibold text-ink-900 hover:text-brand-700"
                    onClick={() => navigate(`/broadcasts/${b.id}`)}
                  >
                    {b.name}
                  </a>
                  <span class="truncate text-xs text-stone-500">{subtitle}</span>
                  {b.updated_at ? <span class="truncate text-[11px] text-stone-400">Edited {agoLabel(b.updated_at)}</span> : null}
                </span>

                {/* Status badge — fixed column → aligned across rows */}
                <span class="justify-self-start">
                  <Badge data-testid="broadcast-status" tone={toneFor(b.status)}>
                    {b.status}
                  </Badge>
                </span>

                {/* Right slot: metrics (sent) OR actions (draft/scheduled), right-aligned */}
                <span class="flex items-center justify-end gap-4">
                  {b.status === 'sent' && s ? (
                    <span data-testid="broadcast-metrics" class="flex items-center gap-5 text-center text-sm tabular-nums">
                      <span class="flex flex-col">
                        <span class="text-[11px] uppercase tracking-wide text-stone-400">Failed</span>
                        <span class={s.failed > 0 ? 'font-semibold text-rose-600' : 'text-stone-500'}>{s.failed}</span>
                      </span>
                      <span class="flex flex-col">
                        <span class="text-[11px] uppercase tracking-wide text-stone-400">Delivered</span>
                        <span class="font-semibold text-ink-900">{s.delivered}</span>
                      </span>
                      <span class="flex flex-col" title={`${s.clicked} clicks`}>
                        <span class="text-[11px] uppercase tracking-wide text-stone-400">Clicked</span>
                        <span class="font-semibold text-emerald-700">{pct(s.clicked, s.delivered)}</span>
                      </span>
                    </span>
                  ) : null}
                  {editable ? (
                    <Button data-testid="broadcast-edit" variant="secondary" size="sm" onClick={() => navigate(`/broadcasts/${b.id}`)}>
                      {b.status === 'scheduled' ? 'Continue editing' : 'Edit'}
                    </Button>
                  ) : null}
                  {editable ? (
                    <Button
                      data-testid="send-broadcast"
                      variant="secondary"
                      size="sm"
                      disabled={blockSend}
                      title={blockSend ? 'Verify a sending domain in Workspace settings before sending.' : undefined}
                      onClick={() => send(b.id)}
                    >
                      Send
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div data-testid="broadcast-list">
          <EmptyState>No broadcasts yet — create one with “New broadcast”.</EmptyState>
        </div>
      )}

    </section>
  );
}

// --- Creation / edit wizard -------------------------------------------------

const STEPS = ['Audience', 'Content', 'Schedule'] as const;

/** Convert a stored ISO timestamp to a datetime-local input value (local time). */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BroadcastWizard({ id }: { id?: string }) {
  const editing = Boolean(id);
  const [step, setStep] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState('');
  const [segId, setSegId] = useState('');
  const [tplId, setTplId] = useState('');
  // The broadcast's WORKING COPY of a template (kind='copy'): picking a library
  // template clones it so this broadcast's content is independently editable and
  // the library original stays pristine.
  const [attachedCopy, setAttachedCopy] = useState<{ id: string; name: string } | null>(null);
  const [scheduleMode, setScheduleMode] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([
      api.get<{ segments: Segment[] }>('/segments'),
      api.get<{ templates: Template[] }>('/templates'),
    ]).then(([s, t]) => {
      setSegments(s.segments);
      setTemplates(t.templates);
    });
  }, []);

  // Edit mode: load the broadcast and prefill. A sent/sending broadcast is not
  // editable → bounce back to the list.
  useEffect(() => {
    if (!id) return;
    void api
      .get<{ broadcast: Broadcast & { audience_ref: string; template_id: string | null } }>(`/broadcasts/${id}`)
      .then((r) => {
        const b = r.broadcast;
        if (!EDITABLE.has(b.status)) {
          navigate('/broadcasts');
          return;
        }
        setName(b.name);
        setSegId(b.audience_ref ?? '');
        setTplId(b.template_id ?? '');
        if (b.scheduled_at) {
          setScheduleMode('later');
          setScheduledAt(isoToLocalInput(b.scheduled_at));
        }
        // Returning from the email editor (Design email): select the template we
        // just saved and jump to the Content step. Applied AFTER the broadcast's
        // own fields so it wins over the (older) saved template_id.
        const justSaved = takeReturnedTemplate();
        if (justSaved) {
          setTplId(justSaved);
          setStep(1);
        }
        // Resolve the attached template: a kind='copy' row is this broadcast's
        // working copy (shown as such in the dropdown).
        const attached = justSaved || b.template_id;
        if (attached) {
          void api
            .get<{ template: { id: string; name: string; kind: string } }>(`/templates/${attached}`)
            .then((t) => {
              if (t.template.kind === 'copy') setAttachedCopy({ id: t.template.id, name: t.template.name });
            })
            .catch(() => undefined);
        }
      })
      .catch(() => navigate('/broadcasts'));
  }, [id]);

  /**
   * Template picked in the dropdown. A LIBRARY template is CLONED on the spot —
   * the broadcast then points at its own mutable copy (re-editable via Design
   * email) and the library original is never touched. Re-picking the existing
   * copy just selects it.
   */
  const pickTemplate = async (value: string): Promise<void> => {
    if (!value || value === attachedCopy?.id) {
      setTplId(value);
      return;
    }
    const lib = templates.find((t) => t.id === value);
    if (!lib) {
      setTplId(value);
      return;
    }
    const r = await api.post<{ template: { id: string; name: string } }>(`/templates/${value}/clone`, { body: {} });
    setAttachedCopy({ id: r.template.id, name: r.template.name });
    setTplId(r.template.id);
  };

  /**
   * Open the email editor to design content for THIS broadcast. We persist the
   * broadcast as a draft first (so the wizard state survives the round-trip and
   * we have a URL to return to), then hand the editor a return path. On save the
   * editor comes back here with the new template selected.
   */
  const designEmail = async () => {
    const body = {
      name: name || 'Untitled broadcast',
      audience_kind: 'segment',
      audience_ref: segId,
      template_id: tplId || null,
      scheduled_at: scheduleMode === 'later' && scheduledAt ? new Date(scheduledAt).toISOString() : null,
    };
    let bid = id;
    if (id) {
      await api.put(`/broadcasts/${id}`, { body });
    } else {
      const r = await api.post<{ broadcast: { id: string } }>('/broadcasts', { body });
      bid = r.broadcast.id;
    }
    if (tplId) {
      setEditorReturn(`/broadcasts/${bid}`);
      navigate(`/editor/${tplId}`);
    } else {
      // Designing from scratch for this broadcast → the editor saves a working
      // COPY (not a library template).
      setEditorReturn(`/broadcasts/${bid}`, { createAs: 'copy' });
      navigate('/editor');
    }
  };

  const segName = segments.find((s) => s.id === segId)?.name ?? '—';
  const tplName =
    tplId === attachedCopy?.id && attachedCopy
      ? `${attachedCopy.name} (this broadcast's copy)`
      : (templates.find((t) => t.id === tplId)?.name ?? '—');

  const canNext = step === 0 ? name.trim().length > 0 && segId !== '' : step === 1 ? tplId !== '' : true;
  const canSave =
    name.trim().length > 0 && segId !== '' && tplId !== '' && (scheduleMode === 'now' || scheduledAt !== '');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = {
        name: name || 'Untitled broadcast',
        audience_kind: 'segment',
        audience_ref: segId,
        template_id: tplId,
        scheduled_at: scheduleMode === 'later' && scheduledAt ? new Date(scheduledAt).toISOString() : null,
      };
      if (editing && id) {
        await api.put(`/broadcasts/${id}`, { body });
      } else {
        await api.post('/broadcasts', { body });
      }
      navigate('/broadcasts');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="broadcast-wizard">
      <button data-testid="broadcasts-back" class="btn-ghost mb-4 btn-sm" onClick={() => navigate('/broadcasts')}>
        ← Back to broadcasts
      </button>
      <PageHeader
        title={editing ? 'Edit broadcast' : 'New broadcast'}
        subtitle="Pick an audience and content, then send now or schedule."
      />

      {/* Step indicator */}
      <ol class="mb-5 flex items-center gap-2 text-sm">
        {STEPS.map((label, i) => (
          <li key={label} class="flex items-center gap-2">
            <span
              data-testid={`wizard-step-${i}`}
              class={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                i === step
                  ? 'bg-brand-600 text-white'
                  : i < step
                    ? 'bg-brand-100 text-brand-700'
                    : 'bg-stone-100 text-stone-400'
              }`}
            >
              {i + 1}
            </span>
            <span class={i === step ? 'font-semibold text-ink-900' : 'text-stone-500'}>{label}</span>
            {i < STEPS.length - 1 ? <span class="text-stone-300">›</span> : null}
          </li>
        ))}
      </ol>

      <Card class="max-w-2xl p-5">
        {step === 0 ? (
          <div class="space-y-4">
            <Field label="Broadcast name">
              <Input
                data-testid="broadcast-name"
                placeholder="Spring announcement"
                value={name}
                onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Audience (segment)">
              <Select
                data-testid="broadcast-segment"
                value={segId}
                onChange={(e: Event) => setSegId((e.target as HTMLSelectElement).value)}
              >
                <option value="">Select segment</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : step === 1 ? (
          <div class="flex items-end justify-between gap-3">
            <Field label="Email template" class="flex-1">
              <Select
                data-testid="broadcast-template"
                value={tplId}
                onChange={(e: Event) => void pickTemplate((e.target as HTMLSelectElement).value)}
              >
                <option value="">Select template</option>
                {attachedCopy ? (
                  <option value={attachedCopy.id}>{attachedCopy.name} — this broadcast's copy</option>
                ) : null}
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button data-testid="design-email" variant="secondary" onClick={designEmail}>
              Design email
            </Button>
          </div>
        ) : (
          <div class="space-y-4">
            <Field label="When to send">
              <Select
                data-testid="schedule-mode"
                value={scheduleMode}
                onChange={(e: Event) => setScheduleMode((e.target as HTMLSelectElement).value as 'now' | 'later')}
              >
                <option value="now">Send manually (save as draft)</option>
                <option value="later">Schedule for a date &amp; time</option>
              </Select>
            </Field>
            {scheduleMode === 'later' ? (
              <Field label="Scheduled time">
                <Input
                  data-testid="broadcast-scheduled-at"
                  type="datetime-local"
                  value={scheduledAt}
                  onInput={(e: Event) => setScheduledAt((e.target as HTMLInputElement).value)}
                />
              </Field>
            ) : null}

            {/* Review */}
            <dl
              data-testid="wizard-review"
              class="mt-2 grid grid-cols-[8rem_1fr] gap-y-1.5 rounded-lg border border-stone-200 bg-stone-50/60 p-3 text-sm"
            >
              <dt class="text-stone-500">Name</dt>
              <dd class="text-ink-900">{name || '—'}</dd>
              <dt class="text-stone-500">Audience</dt>
              <dd class="text-ink-900">{segName}</dd>
              <dt class="text-stone-500">Template</dt>
              <dd class="text-ink-900">{tplName}</dd>
              <dt class="text-stone-500">When</dt>
              <dd class="text-ink-900">
                {scheduleMode === 'later' && scheduledAt ? fmtDate(new Date(scheduledAt).toISOString()) : 'Manual (draft)'}
              </dd>
            </dl>
          </div>
        )}

        {error ? <p data-testid="wizard-error" class="mt-3 text-sm text-rose-600">{error}</p> : null}

        <div class="mt-5 flex items-center gap-3 border-t border-stone-100 pt-4">
          {step > 0 ? (
            <Button data-testid="wizard-back" variant="ghost" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <Button data-testid="wizard-next" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              Next
            </Button>
          ) : (
            <Button data-testid="wizard-save" disabled={!canSave || saving} onClick={save}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create broadcast'}
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}
