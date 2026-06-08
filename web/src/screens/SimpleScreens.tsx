// Lean read-mostly screens (§12): Dashboards, ProfileExplorer, SuppressionList,
// BillingUsageView. Each fetches its workspace-scoped data from the API (the
// server scopes by the token's workspace_id) and renders a styled table/list.
// (Visual redesign; all data-testid attributes preserved.)
import { useEffect, useRef, useState } from 'preact/hooks';
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

// A configurable column id: the built-in External ID, or an attribute key.
const EXT_COL = 'external_id';
const ATTR_PREFIX = 'attr:';
const isAttrCol = (id: string) => id.startsWith(ATTR_PREFIX);
const attrKeyOf = (id: string) => id.slice(ATTR_PREFIX.length);
const attrColCount = (order: readonly string[]) => order.filter(isAttrCol).length;

/** Persisted profile-table column config (per browser): the enabled columns, in order. */
interface ColumnConfig {
  order: string[]; // e.g. ['external_id', 'attr:tier'] — order = display order
}
const COLS_KEY = 'cdp.profileColumns';
const MAX_ATTR_COLS = 3;
function loadCols(): ColumnConfig {
  try {
    const raw = globalThis.localStorage?.getItem(COLS_KEY);
    if (raw) {
      const c = JSON.parse(raw) as Partial<ColumnConfig> & { showExtId?: boolean; attrCols?: string[] };
      if (Array.isArray(c.order)) return { order: c.order };
      // Migrate the previous {showExtId, attrCols} shape.
      const order: string[] = [];
      if (c.showExtId !== false) order.push(EXT_COL);
      for (const k of (c.attrCols ?? []).slice(0, MAX_ATTR_COLS)) order.push(`${ATTR_PREFIX}${k}`);
      return { order };
    }
  } catch {
    /* ignore */
  }
  return { order: [EXT_COL] };
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

  // Configurable, reorderable table columns (persisted): External ID + up to 3
  // attribute columns, in a user-defined order.
  const [cols, setCols] = useState<ColumnConfig>(loadCols);
  const [colsOpen, setColsOpen] = useState(false);
  const [colSearch, setColSearch] = useState('');
  // Close the column picker on any click/escape outside its popover.
  const colsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!colsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (colsRef.current && !colsRef.current.contains(e.target as Node)) setColsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setColsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [colsOpen]);
  const [allAttrKeys, setAllAttrKeys] = useState<string[]>([]);
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(COLS_KEY, JSON.stringify(cols));
    } catch {
      /* ignore */
    }
  }, [cols]);
  // Exhaustive list of attribute keys in the workspace (server DISTINCT), so the
  // picker isn't limited to the loaded page. Reloadable so a newly-created
  // profile's attribute keys appear in the picker without a page refresh.
  const reloadAttrKeys = () =>
    api
      .get<{ keys: string[] }>('/profiles/attribute-keys')
      .then((r) => setAllAttrKeys(r.keys))
      .catch(() => setAllAttrKeys([]));
  useEffect(() => {
    void reloadAttrKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentId]);

  const enabledCol = (id: string) => cols.order.includes(id);
  const toggleCol = (id: string) =>
    setCols((c) => {
      if (c.order.includes(id)) return { order: c.order.filter((x) => x !== id) };
      if (isAttrCol(id) && attrColCount(c.order) >= MAX_ATTR_COLS) return c;
      return { order: [...c.order, id] };
    });
  const moveCol = (id: string, dir: -1 | 1) =>
    setCols((c) => {
      const i = c.order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= c.order.length) return c;
      const next = [...c.order];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { order: next };
    });
  // Picker rows: enabled columns first (in their order, with reorder arrows),
  // then the remaining available attribute keys. External ID is always offered.
  const enabledIds = cols.order;
  const remainingIds = [
    ...(enabledCol(EXT_COL) ? [] : [EXT_COL]),
    ...allAttrKeys.map((k) => `${ATTR_PREFIX}${k}`).filter((id) => !enabledCol(id)),
  ];
  const colLabel = (id: string) => (id === EXT_COL ? 'External ID' : attrKeyOf(id));
  const colSearchMatch = (id: string) => colLabel(id).toLowerCase().includes(colSearch.trim().toLowerCase());
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
      // Stay on the list: close the drawer and refresh so the new row appears,
      // and refresh the attribute-key picker (a new attribute may have been added).
      setAdding(false);
      const opts = segmentId ? { query: { segment_id: segmentId } } : undefined;
      const r = await api.get<{ profiles: Profile[] }>('/profiles', opts);
      setProfiles(r.profiles);
      void reloadAttrKeys();
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
        <div ref={colsRef} class="relative ml-auto">
          <Button
            data-testid="columns-button"
            variant="secondary"
            onClick={() => setColsOpen((v) => !v)}
            aria-label="Configure columns"
          >
            ▥ Columns
          </Button>
          {colsOpen ? (
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
                <div class="mt-2 max-h-72 overflow-y-auto pr-1">
                  {[...enabledIds, ...remainingIds]
                    .filter((id) => id === EXT_COL || colSearchMatch(id))
                    .map((id) => {
                    const on = enabledCol(id);
                    const isExt = id === EXT_COL;
                    const atMax = !on && isAttrCol(id) && attrColCount(cols.order) >= MAX_ATTR_COLS;
                    return (
                      <div
                        data-testid="col-option"
                        data-col={isExt ? 'external_id' : attrKeyOf(id)}
                        key={id}
                        class="flex h-9 items-center gap-2 rounded px-1 hover:bg-stone-50"
                      >
                        <input
                          {...(isExt ? { 'data-testid': 'col-external_id' } : {})}
                          type="checkbox"
                          class="h-4 w-4 shrink-0 accent-brand-500"
                          checked={on}
                          disabled={atMax}
                          onChange={() => toggleCol(id)}
                        />
                        <span
                          class={`flex-1 truncate text-sm text-ink-900 ${isExt ? '' : 'font-mono'} ${
                            atMax ? 'opacity-40' : ''
                          }`}
                        >
                          {colLabel(id)}
                        </span>
                        {on ? (
                          <span class="flex shrink-0 items-center">
                            <button
                              data-testid="col-up"
                              class="rounded px-1 text-stone-400 hover:bg-stone-100 hover:text-ink-900"
                              aria-label={`Move ${colLabel(id)} up`}
                              onClick={() => moveCol(id, -1)}
                            >
                              ↑
                            </button>
                            <button
                              data-testid="col-down"
                              class="rounded px-1 text-stone-400 hover:bg-stone-100 hover:text-ink-900"
                              aria-label={`Move ${colLabel(id)} down`}
                              onClick={() => moveCol(id, 1)}
                            >
                              ↓
                            </button>
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                  {enabledIds.length === 0 && remainingIds.length === 0 ? (
                    <p class="py-2 text-xs text-stone-400">No attributes yet.</p>
                  ) : null}
                </div>
                <p class="mt-2 text-[11px] text-stone-400">Up to {MAX_ATTR_COLS} attribute columns.</p>
              </div>
          ) : null}
        </div>
      </div>
      <Card class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th class="w-8 px-2 py-2.5" />
              <th class="px-4 py-2.5 font-semibold">Email</th>
              <th class="px-4 py-2.5 font-semibold">Status</th>
              {cols.order.map((id) =>
                id === EXT_COL ? (
                  <th data-testid="extid-col-header" key={id} class="px-4 py-2.5 font-semibold">
                    External ID
                  </th>
                ) : (
                  <th data-testid="attr-col-header" key={id} class="px-4 py-2.5 font-semibold">
                    {attrKeyOf(id)}
                  </th>
                ),
              )}
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
                <td class="px-4 py-2.5 text-ink-900">{p.email}</td>
                <td class="px-4 py-2.5">
                  <Badge tone={toneFor(p.email_status)}>{p.email_status}</Badge>
                </td>
                {cols.order.map((id) =>
                  id === EXT_COL ? (
                    <td key={id} class="px-4 py-2.5 font-mono text-xs text-stone-600">
                      {p.external_id}
                    </td>
                  ) : (
                    <td data-testid="attr-col-cell" key={id} class="px-4 py-2.5 text-stone-700">
                      {fmtAttr(p.attributes?.[attrKeyOf(id)])}
                    </td>
                  ),
                )}
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
