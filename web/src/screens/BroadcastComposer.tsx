// Broadcasts (§12, §9A): a LIST screen + a multi-step creation/edit WIZARD.
// - BroadcastComposer (/broadcasts): all broadcasts; "New broadcast" → the wizard;
//   draft/scheduled rows can be edited or sent; sent/sending rows are read-only.
// - BroadcastWizard (/broadcasts/new, /broadcasts/:id): Audience → Content →
//   Schedule. Editing is allowed only while draft or scheduled.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Badge, Button, Card, Field, Input, PageHeader, Select, EmptyState, toneFor } from '../ui/kit.js';

interface Segment {
  id: string;
  name: string;
}
interface Template {
  id: string;
  name: string;
}
interface Broadcast {
  id: string;
  name: string;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
}

const EDITABLE = new Set(['draft', 'scheduled']);

function fmtDate(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

// --- List screen ------------------------------------------------------------

export function BroadcastComposer() {
  const [broadcasts, setBroadcasts] = useState<Broadcast[] | null>(null);
  const [lastResult, setLastResult] = useState('');

  const reload = async () => {
    const b = await api.get<{ broadcasts: Broadcast[] }>('/broadcasts');
    setBroadcasts(b.broadcasts);
  };
  useEffect(() => {
    void reload();
  }, []);

  const send = async (id: string) => {
    const res = await api.post<{ result: { result?: string } }>(`/broadcasts/${id}/send`, {});
    setLastResult(JSON.stringify(res.result));
    await reload();
  };

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

      {broadcasts === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : broadcasts.length ? (
        <ul data-testid="broadcast-list" class="space-y-2">
          {broadcasts.map((b) => {
            const editable = EDITABLE.has(b.status);
            return (
              <li
                data-testid="broadcast-item"
                key={b.id}
                class="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card"
              >
                <span data-testid="broadcast-status" class="flex min-w-0 items-center gap-3">
                  <span class="truncate font-medium text-ink-900">{b.name}</span>
                  <Badge tone={toneFor(b.status)}>{b.status}</Badge>
                  {b.status === 'scheduled' && b.scheduled_at ? (
                    <span class="text-xs text-stone-500">for {fmtDate(b.scheduled_at)}</span>
                  ) : null}
                  {b.status === 'sent' && b.sent_at ? (
                    <span class="text-xs text-stone-500">sent {fmtDate(b.sent_at)}</span>
                  ) : null}
                </span>
                <span class="flex shrink-0 items-center gap-2">
                  {editable ? (
                    <Button
                      data-testid="broadcast-edit"
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/broadcasts/${b.id}`)}
                    >
                      Edit
                    </Button>
                  ) : null}
                  {editable ? (
                    <Button data-testid="send-broadcast" variant="secondary" size="sm" onClick={() => send(b.id)}>
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

      {lastResult ? (
        <p
          data-testid="send-result"
          class="mt-4 rounded-lg bg-stone-900 px-3 py-2 font-mono text-xs text-brand-200"
        >
          {lastResult}
        </p>
      ) : null}
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
      })
      .catch(() => navigate('/broadcasts'));
  }, [id]);

  const segName = segments.find((s) => s.id === segId)?.name ?? '—';
  const tplName = templates.find((t) => t.id === tplId)?.name ?? '—';

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
                onChange={(e: Event) => setTplId((e.target as HTMLSelectElement).value)}
              >
                <option value="">Select template</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button data-testid="design-email" variant="secondary" onClick={() => navigate('/editor')}>
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
