// ProfileDetail (§12, marketer): the single-customer workspace. Four tabs over a
// shared header — Details (edit core fields), Attributes (add/edit the jsonb
// key/value bag), Events (the profile's past behaviour, newest first), and
// Segments (which audiences it currently belongs to). Every read/write is scoped
// SERVER-SIDE to the token's workspace; this screen only ever knows the id.
// Matches the workspace design system (ink/brand/stone). data-testid throughout
// so the Playwright contract can drive the flow.
import { useEffect, useState } from 'preact/hooks';
import { api, sessionStore } from '../store/session.js';
import { useStore } from '../store/store.js';
import { navigate } from '../router.js';
import { ActionMenu, type ActionMenuItem, Badge, Button, Card, EmptyState, Field, Input, Select, toneFor } from '../ui/kit.js';
import { JsonView } from '../ui/JsonView.js';
import { showToast } from '../ui/toast.tsx';
import { MergeProfileDrawer } from './MergeProfileDrawer.js';
import { SendEventDrawer } from './SendEventDrawer.js';

interface Profile {
  id: string;
  external_id: string | null;
  email: string | null;
  email_status: string;
  created_at?: string;
  created_at_unix?: number;
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
  entered_at: string | null;
}
interface AttrPair {
  key: string;
  value: string;
}

const TABS = [
  { id: 'details', label: 'Details' },
  { id: 'attributes', label: 'Attributes' },
  { id: 'delivery', label: 'Delivery' },
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
function fmt(ts: number | string | null | undefined): string {
  if (ts === null || ts === undefined || ts === '') return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

export function ProfileDetail({ id }: { id: string }) {
  const session = useStore(sessionStore);
  const [tab, setTab] = useState<TabId>('details');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [features, setFeatures] = useState<Features | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [merging, setMerging] = useState(false);
  const [sendingEvent, setSendingEvent] = useState(false);
  // Bumped after a manual event is recorded so the Events tab remounts + refetches.
  const [eventsReloadKey, setEventsReloadKey] = useState(0);

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

  // Copy the recipient's subscription-preferences link (the exact, TOKENIZED page
  // they see when they click "manage subscription" in an email). The token can't be
  // built client-side, so fetch the server-built link (byte-identical to the emailed
  // one) and copy it.
  const copyPrefLink = async (): Promise<void> => {
    if (!profile?.email || !session.workspaceId) return;
    let url = '';
    try {
      const r = await api.get<{ url: string }>(`/profiles/${id}/subscription-link`);
      url = r.url;
    } catch {
      showToast('Could not build the subscription link.', { tone: 'error' });
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast('Subscription link copied to the clipboard.', { tone: 'success' });
    } catch {
      // Clipboard unavailable (e.g. insecure context) — surface the link so it can be copied by hand.
      showToast(url, { tone: 'info' });
    }
  };

  const profileActions: ActionMenuItem[] = [
    { label: 'Send event', onSelect: () => setSendingEvent(true), 'data-testid': 'send-event-action' },
    ...(profile?.email && session.workspaceId
      ? [{ label: 'Copy subscription link', onSelect: copyPrefLink, 'data-testid': 'copy-subscription-link' } satisfies ActionMenuItem]
      : []),
    { label: 'Merge…', onSelect: () => setMerging(true), 'data-testid': 'merge-button' },
  ];

  return (
    <section data-testid="profile-detail">
      <div class="mb-4 flex items-center justify-between">
        <button data-testid="profile-back" class="btn-ghost btn-sm" onClick={() => navigate('/profiles')}>
          ← Back to profiles
        </button>
        {profile ? (
          <ActionMenu data-testid="profile-actions" items={profileActions} />
        ) : null}
      </div>

      {profile ? (
        <MergeProfileDrawer
          open={merging}
          profile={{
            id: profile.id,
            email: profile.email,
            external_id: profile.external_id,
            ...(profile.created_at ? { created_at: profile.created_at } : {}),
            ...(profile.created_at_unix ? { created_at_unix: profile.created_at_unix } : {}),
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

      {profile ? (
        <SendEventDrawer
          open={sendingEvent}
          profileId={profile.id}
          onClose={() => setSendingEvent(false)}
          onSent={() => {
            setSendingEvent(false);
            void load(); // refresh the header stats (features recomputed server-side)
            setEventsReloadKey((k) => k + 1);
            setTab('events'); // show the just-recorded event
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
          {profile?.created_at || profile?.created_at_unix ? (
            <p data-testid="profile-created" class="mt-0.5 text-xs text-stone-400">
              Created {fmt(profile.created_at_unix ?? profile.created_at)}
            </p>
          ) : null}
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
            role="tab"
            aria-selected={tab === t.id}
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
      ) : tab === 'delivery' ? (
        <DeliveryTab id={id} />
      ) : tab === 'events' ? (
        <EventsTab id={id} key={eventsReloadKey} />
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
  // Quick-add: append a row pre-filled with an existing workspace attribute key.
  const addKey = (k: string) =>
    setPairs((ps) => (ps.some((p) => p.key === k) ? ps : [...ps, { key: k, value: '' }]));

  // The exhaustive set of attribute keys used across the workspace, minus the
  // ones already on this profile — offered as one-click chips.
  const [allKeys, setAllKeys] = useState<string[]>([]);
  useEffect(() => {
    void api
      .get<{ keys: string[] }>('/profiles/attribute-keys')
      .then((r) => setAllKeys(r.keys))
      .catch(() => setAllKeys([]));
  }, []);
  const used = new Set(pairs.map((p) => p.key.trim()).filter(Boolean));
  const unused = allKeys.filter((k) => !used.has(k));

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
    <div class="flex flex-col gap-4 lg:flex-row lg:items-start">
    <Card class="max-w-2xl flex-1 p-5">
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

      {/* Quick-add: existing workspace attribute keys not yet on this profile. */}
      <Card data-testid="unused-attrs" class="w-full p-4 lg:w-64 lg:shrink-0">
        <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Add attribute</p>
        <p class="mb-3 text-xs text-stone-400">Existing keys in this workspace — click to add.</p>
        {unused.length === 0 ? (
          <p class="text-xs text-stone-400">
            {allKeys.length === 0 ? 'No attributes in this workspace yet.' : 'All keys are already on this profile.'}
          </p>
        ) : (
          <div class="flex flex-wrap gap-1.5">
            {unused.map((k) => (
              <button
                key={k}
                data-testid="unused-attr"
                data-key={k}
                onClick={() => addKey(k)}
                aria-label={`Add attribute ${k}`}
                class="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1 font-mono text-xs text-ink-800 transition hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-400/40"
              >
                <span class="text-stone-400">+</span>
                {k}
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// --- Delivery tab: deliverability health -----------------------------------

interface DeliveryInfo {
  email_status: string;
  suppressed: { reason: string; source: string | null; created_at: string } | null;
  soft_bounce_days: number;
  events: Array<{ type: string; sub_type: string | null; occurred_at: string }>;
}

const SOFT_BOUNCE_DAYS_LIMIT = 3;

function DeliveryTab({ id }: { id: string }) {
  const [info, setInfo] = useState<DeliveryInfo | null>(null);
  useEffect(() => {
    void api.get<DeliveryInfo>(`/profiles/${id}/delivery`).then(setInfo);
  }, [id]);

  if (!info) return <p class="text-sm text-stone-500">Loading…</p>;

  return (
    <div data-testid="delivery-tab" class="space-y-5">
      <Card class="p-5">
        <h2 class="text-base font-bold text-ink-900">Deliverability</h2>
        <dl class="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <dt class="text-[11px] uppercase tracking-wide text-stone-500">Email status</dt>
            <dd class="mt-1">
              <Badge data-testid="delivery-status" tone={toneFor(info.email_status)}>
                {info.email_status}
              </Badge>
            </dd>
          </div>
          <div>
            <dt class="text-[11px] uppercase tracking-wide text-stone-500">Suppressed</dt>
            <dd data-testid="delivery-suppression" class="mt-1">
              {info.suppressed ? (
                <span class="text-sm text-ink-900">
                  <Badge tone="danger">{info.suppressed.reason}</Badge>
                  <span class="ml-2 text-xs text-stone-500">
                    {info.suppressed.source ? `via ${info.suppressed.source} · ` : ''}
                    {fmt(info.suppressed.created_at)}
                  </span>
                </span>
              ) : (
                <Badge tone="success">not suppressed</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt class="text-[11px] uppercase tracking-wide text-stone-500">Soft-bounce days</dt>
            <dd data-testid="delivery-soft-days" class="mt-1 text-sm font-semibold text-ink-900">
              {info.soft_bounce_days} / {SOFT_BOUNCE_DAYS_LIMIT}
              <span class="ml-2 text-xs font-normal text-stone-500">
                distinct days since last delivery{' '}
                {info.soft_bounce_days >= SOFT_BOUNCE_DAYS_LIMIT ? '(permanent)' : ''}
              </span>
            </dd>
          </div>
        </dl>
      </Card>

      <Card class="p-5">
        <h2 class="text-base font-bold text-ink-900">Recent delivery events</h2>
        {info.events.length === 0 ? (
          <p class="mt-2 text-sm text-stone-400">No delivery events (deliveries, bounces, complaints) yet.</p>
        ) : (
          <ul class="mt-3 divide-y divide-stone-100">
            {info.events.map((ev, i) => (
              <li data-testid="delivery-event-row" key={i} class="flex items-center justify-between py-2 text-sm">
                <span class="flex items-center gap-2">
                  <Badge tone={toneFor(ev.type === 'delivery' ? 'success' : ev.type)}>{ev.type}</Badge>
                  {ev.sub_type ? <span class="text-xs text-stone-500">{ev.sub_type}</span> : null}
                </span>
                <span class="text-xs text-stone-500">{fmt(ev.occurred_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
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
            <JsonView value={ev.payload} class="mt-1" />
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
