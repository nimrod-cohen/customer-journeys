// ProfileDetail (§12, marketer): the single-customer workspace. Four tabs over a
// shared header — Details (edit core fields), Attributes (add/edit the jsonb
// key/value bag), Events (the profile's past behaviour, newest first), and
// Segments (which audiences it currently belongs to). Every read/write is scoped
// SERVER-SIDE to the token's workspace; this screen only ever knows the id.
// Matches the workspace design system (ink/brand/stone). data-testid throughout
// so the Playwright contract can drive the flow.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Badge, Button, Card, EmptyState, Field, Input, Select, toneFor } from '../ui/kit.js';
import { MergeProfileDrawer } from './MergeProfileDrawer.js';

interface Profile {
  id: string;
  external_id: string | null;
  email: string | null;
  email_status: string;
  attributes: Record<string, unknown>;
}
interface Features {
  total_events: number;
  last_event_at: string | null;
  last_email_open_at: string | null;
  monetary_total: number;
}
interface EventRow {
  event_id: string;
  type: string;
  occurred_at: string;
  received_at: string;
  payload: Record<string, unknown>;
}
interface SegmentRow {
  id: string;
  name: string;
  kind: string;
  source: string;
  entered_at: string;
}
interface AttrPair {
  key: string;
  value: string;
}

const TABS = [
  { id: 'details', label: 'Details' },
  { id: 'attributes', label: 'Attributes' },
  { id: 'events', label: 'Events' },
  { id: 'segments', label: 'Segments' },
] as const;
type TabId = (typeof TABS)[number]['id'];

// Deliverability state only (NOT consent). "unsubscribed" is the separate
// boolean attribute, which can be true alongside any of these.
const EMAIL_STATUSES = ['active', 'bounced', 'complained'];

/** Render an attribute value for editing: strings as-is, everything else as JSON. */
function valueToString(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}
/** Parse an edited value back: try JSON (numbers/bools/objects), else keep string. */
function stringToValue(s: string): unknown {
  const t = s.trim();
  if (t === '') return '';
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return s;
  }
}
function fmt(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function ProfileDetail({ id }: { id: string }) {
  const [tab, setTab] = useState<TabId>('details');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [features, setFeatures] = useState<Features | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [merging, setMerging] = useState(false);

  const load = async () => {
    try {
      const r = await api.get<{ profile: Profile; features: Features | null }>(`/profiles/${id}`);
      setProfile(r.profile);
      setFeatures(r.features);
    } catch {
      setNotFound(true);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (notFound) {
    return (
      <section data-testid="profile-detail">
        <button data-testid="profile-back" class="btn-ghost mb-4 btn-sm" onClick={() => navigate('/profiles')}>
          ← Back to profiles
        </button>
        <EmptyState>Profile not found in this workspace.</EmptyState>
      </section>
    );
  }

  const initials = (profile?.email ?? profile?.external_id ?? '?').slice(0, 2).toUpperCase();

  return (
    <section data-testid="profile-detail">
      <div class="mb-4 flex items-center justify-between">
        <button data-testid="profile-back" class="btn-ghost btn-sm" onClick={() => navigate('/profiles')}>
          ← Back to profiles
        </button>
        {profile ? (
          <Button data-testid="merge-button" variant="secondary" size="sm" onClick={() => setMerging(true)}>
            Merge…
          </Button>
        ) : null}
      </div>

      {profile ? (
        <MergeProfileDrawer
          open={merging}
          profile={{
            id: profile.id,
            email: profile.email,
            external_id: profile.external_id,
            attributes: profile.attributes ?? {},
          }}
          onClose={() => setMerging(false)}
          onMerged={(survivingId) => {
            setMerging(false);
            if (survivingId === id) void load();
            else navigate(`/profiles/${survivingId}`);
          }}
        />
      ) : null}

      {/* Header */}
      <Card class="mb-5 flex flex-wrap items-center gap-4 p-5">
        <span class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand-500/10 font-display text-xl font-bold text-brand-600">
          {initials}
        </span>
        <div class="min-w-0 flex-1">
          <h1 data-testid="profile-email" class="truncate text-xl font-bold text-ink-950">
            {profile?.email ?? '(no email)'}
          </h1>
          <p class="mt-0.5 font-mono text-xs text-stone-500">
            {profile?.external_id ? `ext: ${profile.external_id}` : 'no external id'}
          </p>
        </div>
        {profile ? <Badge tone={toneFor(profile.email_status)}>{profile.email_status}</Badge> : null}
        <div class="flex gap-6 border-l border-stone-200 pl-5 text-center">
          <div>
            <p class="font-display text-2xl font-bold text-ink-950">{features?.total_events ?? 0}</p>
            <p class="text-[11px] uppercase tracking-wide text-stone-500">Events</p>
          </div>
          <div>
            <p class="text-sm font-semibold text-ink-900">{fmt(features?.last_event_at ?? null)}</p>
            <p class="text-[11px] uppercase tracking-wide text-stone-500">Last seen</p>
          </div>
          <div>
            <p class="font-display text-2xl font-bold text-ink-950">
              {features?.monetary_total ?? 0}
            </p>
            <p class="text-[11px] uppercase tracking-wide text-stone-500">Monetary</p>
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <div class="mb-5 flex gap-1 border-b border-stone-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            data-testid={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
            class={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
              tab === t.id
                ? 'border-brand-500 text-ink-950'
                : 'border-transparent text-stone-500 hover:text-ink-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {profile === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : tab === 'details' ? (
        <DetailsTab profile={profile} onSaved={load} />
      ) : tab === 'attributes' ? (
        <AttributesTab profile={profile} onSaved={load} />
      ) : tab === 'events' ? (
        <EventsTab id={id} />
      ) : (
        <SegmentsTab id={id} />
      )}
    </section>
  );
}

// --- Details tab: edit core profile fields ---------------------------------

function DetailsTab({ profile, onSaved }: { profile: Profile; onSaved: () => Promise<void> }) {
  const [email, setEmail] = useState(profile.email ?? '');
  const [externalId, setExternalId] = useState(profile.external_id ?? '');
  const [status, setStatus] = useState(profile.email_status);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [err, setErr] = useState('');

  const save = async () => {
    setState('saving');
    setErr('');
    try {
      await api.patch(`/profiles/${profile.id}`, {
        body: { email, external_id: externalId, email_status: status },
      });
      await onSaved();
      setState('saved');
    } catch (e) {
      setErr((e as { error?: string })?.error ?? 'could not save');
      setState('error');
    }
  };

  return (
    <Card class="max-w-xl p-5">
      <div class="grid gap-4">
        <Field label="Email">
          <Input
            data-testid="profile-email-input"
            type="email"
            value={email}
            onInput={(e: Event) => setEmail((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="External ID" hint="Your system's identifier for this customer.">
          <Input
            data-testid="profile-externalid-input"
            value={externalId}
            onInput={(e: Event) => setExternalId((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Email status">
          <Select
            data-testid="profile-status-select"
            class="w-56"
            value={status}
            onChange={(e: Event) => setStatus((e.target as HTMLSelectElement).value)}
          >
            {EMAIL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div class="mt-5 flex items-center gap-3">
        <Button data-testid="profile-save" onClick={save} disabled={state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Save changes'}
        </Button>
        {state === 'saved' ? (
          <span data-testid="profile-save-status" class="text-sm font-medium text-emerald-600">
            Saved
          </span>
        ) : null}
        {state === 'error' ? (
          <span data-testid="profile-save-status" class="text-sm font-medium text-rose-600">
            {err}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

// --- Attributes tab: add/edit/remove the jsonb bag -------------------------

function AttributesTab({ profile, onSaved }: { profile: Profile; onSaved: () => Promise<void> }) {
  const initial = (): AttrPair[] =>
    Object.entries(profile.attributes ?? {}).map(([key, value]) => ({
      key,
      value: valueToString(value),
    }));
  const [pairs, setPairs] = useState<AttrPair[]>(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [err, setErr] = useState('');

  const setPair = (i: number, patch: Partial<AttrPair>) =>
    setPairs((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const remove = (i: number) => setPairs((ps) => ps.filter((_, j) => j !== i));
  const add = () => setPairs((ps) => [...ps, { key: '', value: '' }]);

  const save = async () => {
    setState('saving');
    setErr('');
    // Build the object from non-empty keys (last write wins on dup keys).
    const attributes: Record<string, unknown> = {};
    for (const p of pairs) {
      const k = p.key.trim();
      if (k) attributes[k] = stringToValue(p.value);
    }
    try {
      await api.patch(`/profiles/${profile.id}`, { body: { attributes } });
      await onSaved();
      setState('saved');
    } catch (e) {
      setErr((e as { error?: string })?.error ?? 'could not save');
      setState('error');
    }
  };

  return (
    <Card class="max-w-2xl p-5">
      <div class="space-y-2.5">
        {pairs.length === 0 ? (
          <p class="text-sm text-stone-500">No attributes yet — add one below.</p>
        ) : null}
        {pairs.map((p, i) => (
          <div data-testid="attr-row" key={i} class="flex items-center gap-2.5">
            <Input
              data-testid="attr-key"
              class="w-1/3"
              placeholder="key"
              value={p.key}
              onInput={(e: Event) => setPair(i, { key: (e.target as HTMLInputElement).value })}
            />
            <Input
              data-testid="attr-value"
              class="flex-1"
              placeholder="value"
              value={p.value}
              onInput={(e: Event) => setPair(i, { value: (e.target as HTMLInputElement).value })}
            />
            <Button
              data-testid="attr-remove"
              variant="ghost"
              size="sm"
              aria-label={`Remove attribute ${p.key || i}`}
              onClick={() => remove(i)}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>
      <p class="mt-2 text-xs text-stone-400">
        Values are stored as text; valid JSON (e.g. <code>42</code>, <code>true</code>,{' '}
        <code>["a","b"]</code>) is kept typed.
      </p>
      <div class="mt-4 flex items-center gap-3">
        <Button data-testid="attr-add" variant="secondary" size="sm" onClick={add}>
          + Add attribute
        </Button>
        <Button data-testid="attrs-save" onClick={save} disabled={state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Save attributes'}
        </Button>
        {state === 'saved' ? (
          <span data-testid="attrs-save-status" class="text-sm font-medium text-emerald-600">
            Saved
          </span>
        ) : null}
        {state === 'error' ? (
          <span data-testid="attrs-save-status" class="text-sm font-medium text-rose-600">
            {err}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

// --- Events tab: behavioural timeline --------------------------------------

function EventsTab({ id }: { id: string }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  useEffect(() => {
    void api.get<{ events: EventRow[] }>(`/profiles/${id}/events`).then((r) => setEvents(r.events));
  }, [id]);

  if (events === null) return <p class="text-sm text-stone-500">Loading…</p>;
  if (events.length === 0)
    return <EmptyState>No events recorded for this profile yet.</EmptyState>;

  return (
    <ol class="relative ml-2 space-y-4 border-l border-stone-200 pl-6">
      {events.map((ev) => (
        <li data-testid="event-row" key={ev.event_id} class="relative">
          <span class="absolute -left-[1.6rem] top-1.5 h-2.5 w-2.5 rounded-full bg-brand-500 ring-4 ring-white" />
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <span class="font-semibold text-ink-900">{ev.type}</span>
            <time class="font-mono text-xs text-stone-500">{fmt(ev.occurred_at)}</time>
          </div>
          {ev.payload && Object.keys(ev.payload).length > 0 ? (
            <pre class="mt-1 overflow-x-auto rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600 ring-1 ring-inset ring-stone-100">
              {JSON.stringify(ev.payload)}
            </pre>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

// --- Segments tab: which audiences this profile is in ----------------------

function SegmentsTab({ id }: { id: string }) {
  const [segments, setSegments] = useState<SegmentRow[] | null>(null);
  useEffect(() => {
    void api
      .get<{ segments: SegmentRow[] }>(`/profiles/${id}/segments`)
      .then((r) => setSegments(r.segments));
  }, [id]);

  if (segments === null) return <p class="text-sm text-stone-500">Loading…</p>;
  if (segments.length === 0)
    return <EmptyState>This profile isn’t a member of any segment.</EmptyState>;

  return (
    <Card class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
          <tr>
            <th class="px-4 py-2.5 font-semibold">Segment</th>
            <th class="px-4 py-2.5 font-semibold">Kind</th>
            <th class="px-4 py-2.5 font-semibold">Source</th>
            <th class="px-4 py-2.5 font-semibold">Entered</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-stone-100">
          {segments.map((s) => (
            <tr data-testid="profile-segment-row" key={s.id} class="hover:bg-stone-50/70">
              <td class="px-4 py-2.5 font-medium text-ink-900">{s.name}</td>
              <td class="px-4 py-2.5">
                <Badge tone="neutral">{s.kind}</Badge>
              </td>
              <td class="px-4 py-2.5 text-stone-600">{s.source}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-stone-500">{fmt(s.entered_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
