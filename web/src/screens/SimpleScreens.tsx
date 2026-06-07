// Lean read-mostly screens (§12): Dashboards, ProfileExplorer, SuppressionList,
// BillingUsageView. Each fetches its workspace-scoped data from the API (the
// server scopes by the token's workspace_id) and renders a styled table/list.
// (Visual redesign; all data-testid attributes preserved.)
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Badge, Card, EmptyState, Input, PageHeader, Select, Stat, toneFor } from '../ui/kit.js';

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
      <PageHeader title="Profiles" subtitle="Unified customer profiles in this workspace." />
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
      </div>
      <Card class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th class="px-4 py-2.5 font-semibold">External ID</th>
              <th class="px-4 py-2.5 font-semibold">Email</th>
              <th class="px-4 py-2.5 font-semibold">Status</th>
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
                <td class="px-4 py-2.5 font-mono text-xs text-stone-600">{p.external_id}</td>
                <td class="px-4 py-2.5 text-ink-900">{p.email}</td>
                <td class="px-4 py-2.5">
                  <Badge tone={toneFor(p.email_status)}>{p.email_status}</Badge>
                </td>
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
