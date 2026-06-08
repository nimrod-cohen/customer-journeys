// Lean read-mostly screens (§12): Dashboards, ProfileExplorer, SuppressionList,
// BillingUsageView. Each fetches its workspace-scoped data from the API (the
// server scopes by the token's workspace_id) and renders a styled table/list.
// (Visual redesign; all data-testid attributes preserved.)
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import {
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Stat,
  toneFor,
} from '../ui/kit.js';

/** A key/value attribute row in the new-profile drawer. */
interface AttrPair {
  key: string;
  value: string;
}
/** Parse an edited value: try JSON (numbers/bools/arrays), else keep the string. */
function parseAttrValue(s: string): unknown {
  const t = s.trim();
  if (t === '') return '';
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return s;
  }
}

export function Dashboards() {
  const [s, setS] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    void api.get<Record<string, number>>('/dashboards/summary').then(setS);
  }, []);
  return (
    <section data-testid="dashboards">
      <PageHeader title="Dashboards" subtitle="Workspace activity at a glance." />
      {s ? (
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Profiles" value={s.profiles} testId="dash-profiles" />
          <Stat label="Segments" value={s.segments} testId="dash-segments" />
          <Stat label="Broadcasts" value={s.broadcasts} testId="dash-broadcasts" />
          <Stat label="Messages sent" value={s.messages_sent} testId="dash-messages" />
        </div>
      ) : (
        <p class="text-sm text-stone-500">Loading…</p>
      )}
    </section>
  );
}

interface Profile {
  id: string;
  external_id: string;
  email: string;
  email_status: string;
  unsubscribed?: boolean;
  attributes?: Record<string, unknown>;
}

/** Render an attribute value for a table cell. */
function fmtAttr(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Persisted profile-table column config (per browser). */
interface ColumnConfig {
  showExtId: boolean;
  attrCols: string[]; // ordered, max 3
}
const COLS_KEY = 'cdp.profileColumns';
const MAX_ATTR_COLS = 3;
function loadCols(): ColumnConfig {
  try {
    const raw = globalThis.localStorage?.getItem(COLS_KEY);
    if (raw) {
      const c = JSON.parse(raw) as ColumnConfig;
      return { showExtId: c.showExtId !== false, attrCols: (c.attrCols ?? []).slice(0, MAX_ATTR_COLS) };
    }
  } catch {
    /* ignore */
  }
  return { showExtId: true, attrCols: [] };
}

/** A small "unsubscribed" (bell with a slash) marker shown next to opted-out profiles. */
function UnsubscribedIcon() {
  return (
    <span
      data-testid="profile-unsub"
      title="Unsubscribed"
      aria-label="Unsubscribed"
      class="inline-flex items-center text-rose-500"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        <path d="M3 3l18 18" />
      </svg>
    </span>
  );
}

interface SegmentOption {
  id: string;
  name: string;
}

export function ProfileExplorer() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [segments, setSegments] = useState<SegmentOption[]>([]);
  const [segmentId, setSegmentId] = useState('');
  const [q, setQ] = useState('');
  // Manual "add profile" drawer state. Email is the identity key (required);
  // any other id (e.g. external_id) is just another attribute.
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newAttrs, setNewAttrs] = useState<AttrPair[]>([]);
  const [addError, setAddError] = useState('');
  const [creating, setCreating] = useState(false);

  const openDrawer = () => {
    setNewEmail('');
    setNewAttrs([]);
    setAddError('');
    setAdding(true);
  };

  // Configurable table columns (persisted): toggle external_id, plus up to 3
  // attribute columns chosen from a searchable list, reorderable.
  const [cols, setCols] = useState<ColumnConfig>(loadCols);
  const [colsOpen, setColsOpen] = useState(false);
  const [colSearch, setColSearch] = useState('');
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(COLS_KEY, JSON.stringify(cols));
    } catch {
      /* ignore */
    }
  }, [cols]);
  // Attribute keys present across the loaded profiles (the picker's options).
  const availableAttrKeys = (() => {
    const set = new Set<string>();
    for (const p of profiles) for (const k of Object.keys(p.attributes ?? {})) if (k !== 'unsubscribed') set.add(k);
    // Keep already-chosen keys even if no row currently has them.
    for (const k of cols.attrCols) set.add(k);
    return [...set].sort((a, b) => a.localeCompare(b));
  })();
  const toggleAttrCol = (key: string) =>
    setCols((c) =>
      c.attrCols.includes(key)
        ? { ...c, attrCols: c.attrCols.filter((k) => k !== key) }
        : c.attrCols.length >= MAX_ATTR_COLS
          ? c
          : { ...c, attrCols: [...c.attrCols, key] },
    );
  const moveAttrCol = (key: string, dir: -1 | 1) =>
    setCols((c) => {
      const i = c.attrCols.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= c.attrCols.length) return c;
      const next = [...c.attrCols];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...c, attrCols: next };
    });
  const setAttr = (i: number, patch: Partial<AttrPair>) =>
    setNewAttrs((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addAttr = () => setNewAttrs((rs) => [...rs, { key: '', value: '' }]);
  const removeAttr = (i: number) => setNewAttrs((rs) => rs.filter((_, j) => j !== i));
  // The segment list populates the filter dropdown.
  useEffect(() => {
    void api.get<{ segments: SegmentOption[] }>('/segments').then((r) => setSegments(r.segments));
  }, []);
  // Reload profiles whenever the segment filter changes (server-side membership
  // filter; text search stays client-side on top of the result).
  useEffect(() => {
    const opts = segmentId ? { query: { segment_id: segmentId } } : undefined;
    void api.get<{ profiles: Profile[] }>('/profiles', opts).then((r) => setProfiles(r.profiles));
  }, [segmentId]);

  const createProfile = async () => {
    setAddError('');
    setCreating(true);
    // Build the attributes object from non-empty keys (last write wins on dups).
    const attributes: Record<string, unknown> = {};
    for (const p of newAttrs) {
      const k = p.key.trim();
      if (k) attributes[k] = parseAttrValue(p.value);
    }
    try {
      await api.post('/profiles', { body: { email: newEmail.trim(), attributes } });
      // Stay on the list: close the drawer and refresh so the new row appears.
      setAdding(false);
      const opts = segmentId ? { query: { segment_id: segmentId } } : undefined;
      const r = await api.get<{ profiles: Profile[] }>('/profiles', opts);
      setProfiles(r.profiles);
    } catch (e) {
      setAddError((e as { error?: string })?.error ?? 'could not create profile');
    } finally {
      setCreating(false);
    }
  };

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? profiles.filter(
        (p) =>
          (p.email ?? '').toLowerCase().includes(needle) ||
          (p.external_id ?? '').toLowerCase().includes(needle),
      )
    : profiles;
  return (
    <section data-testid="profile-explorer">
      <PageHeader
        title="Profiles"
        subtitle="Unified customer profiles in this workspace."
        actions={
          <Button data-testid="new-profile" onClick={openDrawer}>
            + New profile
          </Button>
        }
      />

      <Drawer
        open={adding}
        onClose={() => setAdding(false)}
        title="New profile"
        subtitle="Create a customer profile and set its attributes."
        testId="new-profile-drawer"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              data-testid="create-profile"
              onClick={createProfile}
              disabled={!newEmail.trim() || creating}
            >
              {creating ? 'Creating…' : 'Create profile'}
            </Button>
          </>
        }
      >
        <div class="space-y-4">
          <Field
            label="Email"
            hint="The identity key — events from any source are stitched to this person by email (required)."
          >
            <Input
              data-testid="new-profile-email"
              type="email"
              placeholder="person@company.com"
              value={newEmail}
              onInput={(e: Event) => setNewEmail((e.target as HTMLInputElement).value)}
            />
          </Field>

          <div>
            <span class="label">Attributes</span>
            <div class="mt-1 space-y-2">
              {newAttrs.length === 0 ? (
                <p class="text-xs text-stone-400">No attributes yet — add key/value pairs below.</p>
              ) : null}
              {newAttrs.map((p, i) => (
                <div data-testid="new-attr-row" key={i} class="flex items-center gap-2">
                  <Input
                    data-testid="new-attr-key"
                    class="w-1/3"
                    placeholder="key"
                    value={p.key}
                    onInput={(e: Event) => setAttr(i, { key: (e.target as HTMLInputElement).value })}
                  />
                  <Input
                    data-testid="new-attr-value"
                    class="flex-1"
                    placeholder="value"
                    value={p.value}
                    onInput={(e: Event) => setAttr(i, { value: (e.target as HTMLInputElement).value })}
                  />
                  <Button
                    data-testid="new-attr-remove"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove attribute ${p.key || i}`}
                    onClick={() => removeAttr(i)}
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
            <Button data-testid="new-attr-add" variant="secondary" size="sm" class="mt-2" onClick={addAttr}>
              + Add attribute
            </Button>
            <p class="mt-2 text-xs text-stone-400">
              Values are stored as text; valid JSON (e.g. <code>42</code>, <code>true</code>) is kept typed.
            </p>
          </div>

          {addError ? (
            <p data-testid="new-profile-error" class="text-sm text-rose-600">
              {addError}
            </p>
          ) : null}
        </div>
      </Drawer>

      <div class="mb-4 flex flex-wrap items-center gap-3">
        <Input
          data-testid="profile-search"
          class="max-w-sm flex-1"
          type="search"
          placeholder="Search by email or external ID…"
          value={q}
          onInput={(e: Event) => setQ((e.target as HTMLInputElement).value)}
        />
        <Select
          data-testid="profile-segment-filter"
          class="w-56"
          value={segmentId}
          onChange={(e: Event) => setSegmentId((e.target as HTMLSelectElement).value)}
        >
          <option value="">All segments</option>
          {segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>

        {/* Column picker */}
        <div class="relative ml-auto">
          <Button
            data-testid="columns-button"
            variant="secondary"
            onClick={() => setColsOpen((v) => !v)}
            aria-label="Configure columns"
          >
            ▥ Columns
          </Button>
          {colsOpen ? (
            <>
              <div class="fixed inset-0 z-30" onClick={() => setColsOpen(false)} aria-hidden="true" />
              <div
                data-testid="columns-menu"
                class="absolute right-0 z-40 mt-2 w-80 rounded-xl border border-stone-200 bg-white p-3 shadow-soft"
              >
                <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">Columns</p>
                <Input
                  data-testid="columns-search"
                  type="search"
                  placeholder="Search attributes…"
                  value={colSearch}
                  onInput={(e: Event) => setColSearch((e.target as HTMLInputElement).value)}
                />
                <label class="mt-3 flex items-center gap-2 text-sm text-ink-900">
                  <input
                    data-testid="col-external_id"
                    type="checkbox"
                    checked={cols.showExtId}
                    onChange={() => setCols((c) => ({ ...c, showExtId: !c.showExtId }))}
                  />
                  External ID
                </label>
                <div class="mt-1 max-h-72 overflow-y-auto">
                  {availableAttrKeys
                    .filter((k) => k.toLowerCase().includes(colSearch.trim().toLowerCase()))
                    .map((k) => {
                      const selected = cols.attrCols.includes(k);
                      const atMax = !selected && cols.attrCols.length >= MAX_ATTR_COLS;
                      return (
                        <div
                          data-testid="col-option"
                          data-col={k}
                          key={k}
                          class="flex items-center justify-between gap-2 py-1"
                        >
                          <label class={`flex flex-1 items-center gap-2 text-sm ${atMax ? 'opacity-40' : 'text-ink-900'}`}>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={atMax}
                              onChange={() => toggleAttrCol(k)}
                            />
                            <span class="truncate font-mono text-xs">{k}</span>
                          </label>
                          {selected ? (
                            <span class="flex items-center gap-0.5">
                              <button
                                data-testid="col-up"
                                class="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-ink-900"
                                aria-label={`Move ${k} up`}
                                onClick={() => moveAttrCol(k, -1)}
                              >
                                ↑
                              </button>
                              <button
                                data-testid="col-down"
                                class="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-ink-900"
                                aria-label={`Move ${k} down`}
                                onClick={() => moveAttrCol(k, 1)}
                              >
                                ↓
                              </button>
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  {availableAttrKeys.length === 0 ? (
                    <p class="py-2 text-xs text-stone-400">No attributes on these profiles yet.</p>
                  ) : null}
                </div>
                <p class="mt-2 text-[11px] text-stone-400">Up to {MAX_ATTR_COLS} attribute columns.</p>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <Card class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th class="w-8 px-2 py-2.5" />
              {cols.showExtId ? (
                <th data-testid="extid-col-header" class="px-4 py-2.5 font-semibold">
                  External ID
                </th>
              ) : null}
              <th class="px-4 py-2.5 font-semibold">Email</th>
              <th class="px-4 py-2.5 font-semibold">Status</th>
              {cols.attrCols.map((k) => (
                <th data-testid="attr-col-header" key={k} class="px-4 py-2.5 font-semibold">
                  {k}
                </th>
              ))}
              <th class="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody class="divide-y divide-stone-100">
            {shown.map((p) => (
              <tr
                data-testid="profile-row"
                key={p.id}
                onClick={() => navigate(`/profiles/${p.id}`)}
                class="cursor-pointer hover:bg-stone-50/70"
              >
                <td class="px-2 py-2.5 text-center">{p.unsubscribed ? <UnsubscribedIcon /> : null}</td>
                {cols.showExtId ? (
                  <td class="px-4 py-2.5 font-mono text-xs text-stone-600">{p.external_id}</td>
                ) : null}
                <td class="px-4 py-2.5 text-ink-900">{p.email}</td>
                <td class="px-4 py-2.5">
                  <Badge tone={toneFor(p.email_status)}>{p.email_status}</Badge>
                </td>
                {cols.attrCols.map((k) => (
                  <td data-testid="attr-col-cell" key={k} class="px-4 py-2.5 text-stone-700">
                    {fmtAttr(p.attributes?.[k])}
                  </td>
                ))}
                <td class="px-4 py-2.5 text-right">
                  <button
                    data-testid="profile-open"
                    class="btn-ghost btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/profiles/${p.id}`);
                    }}
                  >
                    View →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <div class="p-4">
            <EmptyState>
              {profiles.length === 0
                ? segmentId
                  ? 'No profiles in this segment.'
                  : 'No profiles yet.'
                : 'No profiles match your search.'}
            </EmptyState>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

interface Suppression {
  email: string;
  reason: string;
}

export function SuppressionList() {
  const [items, setItems] = useState<Suppression[]>([]);
  useEffect(() => {
    void api.get<{ suppressions: Suppression[] }>('/suppressions').then((r) => setItems(r.suppressions));
  }, []);
  return (
    <section data-testid="suppression-list">
      <PageHeader title="Suppressions" subtitle="Addresses excluded from sending in this workspace." />
      {items.length ? (
        <ul class="space-y-2">
          {items.map((s, i) => (
            <li
              data-testid="suppression-row"
              key={i}
              class="flex items-center justify-between rounded-lg border border-stone-200 bg-white px-4 py-2.5 text-sm shadow-card"
            >
              <span class="font-mono text-xs text-ink-900">{s.email}</span>
              <Badge tone={toneFor(s.reason)}>{s.reason}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>No suppressed addresses.</EmptyState>
      )}
    </section>
  );
}

interface Usage {
  period: string;
  metric: string;
  value: number;
}

export function BillingUsageView() {
  const [usage, setUsage] = useState<Usage[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .get<{ usage: Usage[] }>('/billing/usage')
      .then((r) => setUsage(r.usage))
      .catch((e) => setError((e as { error?: string })?.error ?? 'error'));
  }, []);
  return (
    <section data-testid="billing-usage">
      <PageHeader title="Billing & usage" subtitle="Per-workspace metered usage and cost." />
      {error ? (
        <p
          data-testid="billing-error"
          class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200"
        >
          {error}
        </p>
      ) : (
        <Card class="overflow-hidden">
          <table class="w-full text-sm">
            <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th class="px-4 py-2.5 font-semibold">Period</th>
                <th class="px-4 py-2.5 font-semibold">Metric</th>
                <th class="px-4 py-2.5 text-right font-semibold">Value</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-stone-100">
              {usage.map((u, i) => (
                <tr data-testid="usage-row" key={i} class="hover:bg-stone-50/70">
                  <td class="px-4 py-2.5 text-stone-600">{u.period}</td>
                  <td class="px-4 py-2.5 text-ink-900">{u.metric}</td>
                  <td class="px-4 py-2.5 text-right font-mono text-ink-900">{u.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {usage.length === 0 ? <div class="p-4"><EmptyState>No usage recorded yet.</EmptyState></div> : null}
        </Card>
      )}
    </section>
  );
}
