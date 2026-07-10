// Activity log (§12): a unified, filterable feed of everything that happens in
// the workspace — behavioural events, email/delivery events, and sends. Filters
// (datetime range, source, outcome, type) are applied SERVER-SIDE (scoped to the
// token's workspace). Read-only.
import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, sessionStore } from '../store/session.js';
import { useStore } from '../store/store.js';
import { navigate } from '../router.js';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select } from '../ui/kit.js';
import { JsonView } from '../ui/JsonView.js';
import { showToast } from '../ui/toast.js';
import { formatDateTime } from '../ui/datetime.js';

interface ActivityRow {
  at: string;
  source: 'event' | 'email' | 'send';
  type: string;
  outcome: 'success' | 'failure' | 'info';
  profile_id: string | null;
  detail: string | null;
  email: string | null;
  /** messages_log id — present on send rows; enables a manual retry. */
  ref_id: string | null;
  /** True for a FAILED send that can be re-queued. */
  retryable: boolean;
}

interface Filters {
  from: string;
  to: string;
  source: string;
  outcome: string;
  type: string;
}

/** datetime-local value (local wall-clock, no zone) for a Date. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Default the range to TODAY: 00:00 → 23:59 local. */
function todayRange(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
  return { from: toLocalInput(start), to: toLocalInput(end) };
}
const EMPTY_FILTERS: Filters = { from: '', to: '', source: '', outcome: '', type: '' };

function outcomeTone(o: string): 'success' | 'danger' | 'neutral' {
  return o === 'success' ? 'success' : o === 'failure' ? 'danger' : 'neutral';
}
function fmt(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : formatDateTime(d);
}
/** datetime-local value (no seconds/zone) → ISO string for the API. */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function Activity() {
  const session = useStore(sessionStore);
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  // Default the date range to TODAY (computed at mount so it stays current).
  const [filters, setFilters] = useState<Filters>(() => ({ ...EMPTY_FILTERS, ...todayRange() }));
  // Master/detail: which row(s) are expanded to show their detail below.
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  const load = async (f: Filters) => {
    if (!session.workspaceId) {
      setRows([]);
      return;
    }
    const query: Record<string, string> = {};
    const fromIso = toIso(f.from);
    const toIsoV = toIso(f.to);
    if (fromIso) query.from = fromIso;
    if (toIsoV) query.to = toIsoV;
    if (f.source) query.source = f.source;
    if (f.outcome) query.outcome = f.outcome;
    if (f.type.trim()) query.type = f.type.trim();
    const r = await api.get<{ activity: ActivityRow[] }>('/activity', { query });
    setRows(r.activity);
    setOpen(new Set()); // collapse all when the result set changes
  };

  // Initial load + reload when the active workspace changes (re-scope in place).
  useEffect(() => {
    void load(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.workspaceId]);

  // Selected rows (for bulk retry) + rows with a retry IN FLIGHT (locked).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const toggleSelect = (refId: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(refId)) n.delete(refId);
      else n.add(refId);
      return n;
    });
  const retryableIds = (): string[] => (rows ?? []).filter((r) => r.retryable && r.ref_id).map((r) => r.ref_id!);
  const allRetryableSelected = (() => {
    const ids = retryableIds();
    return ids.length > 0 && ids.every((id) => selected.has(id));
  })();
  const toggleSelectAll = () => {
    const ids = retryableIds();
    setSelected(allRetryableSelected ? new Set() : new Set(ids));
  };

  // Flip a retried row to SUCCESS in place (avoids a reload that would show both the
  // original failed row AND a new sent row) and drop its Retry affordance.
  const markSucceeded = (refId: string) =>
    setRows((rs) => rs?.map((r) => (r.ref_id === refId ? { ...r, outcome: 'success', retryable: false } : r)) ?? rs);

  // Retry ONE send. Locked while in flight (no double-clicks). Resolves to the result.
  const retryOne = async (refId: string): Promise<'sent' | 'queued' | 'error'> => {
    setRetrying((s) => new Set(s).add(refId));
    try {
      const r = await api.post<{ result?: string }>(`/messages/${refId}/retry`, {});
      if (r.result === 'send') {
        markSucceeded(refId);
        return 'sent';
      }
      return 'queued';
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not retry', { tone: 'error' });
      return 'error';
    } finally {
      setRetrying((s) => {
        const n = new Set(s);
        n.delete(refId);
        return n;
      });
      setSelected((s) => {
        const n = new Set(s);
        n.delete(refId);
        return n;
      });
    }
  };

  const retrySingle = async (row: ActivityRow) => {
    const res = await retryOne(row.ref_id!);
    const who = row.email ?? 'the recipient';
    if (res === 'sent') showToast(`Re-sent to ${who} ✓`, { tone: 'success', ttl: 5000 });
    else if (res === 'queued') showToast(`Re-queued for ${who} — delivery pending`, { tone: 'info', ttl: 5000 });
  };

  const retrySelected = async () => {
    const ids = [...selected];
    let sent = 0;
    for (const id of ids) if ((await retryOne(id)) === 'sent') sent++;
    showToast(`Retried ${ids.length} — ${sent} re-sent`, { tone: sent ? 'success' : 'info' });
  };

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const apply = () => void load(filters);
  const reset = () => {
    const next = { ...EMPTY_FILTERS, ...todayRange() };
    setFilters(next);
    void load(next);
  };

  return (
    <section data-testid="activity">
      <PageHeader
        title="Activity log"
        subtitle="Everything that happens in this workspace — events, email delivery, and sends."
      />

      <Card class="mb-4 p-4">
        <div class="flex flex-wrap items-end gap-3">
          <Field label="From">
            <Input
              data-testid="activity-from"
              type="datetime-local"
              value={filters.from}
              onInput={(e: Event) => set({ from: (e.target as HTMLInputElement).value })}
            />
          </Field>
          <Field label="To">
            <Input
              data-testid="activity-to"
              type="datetime-local"
              value={filters.to}
              onInput={(e: Event) => set({ to: (e.target as HTMLInputElement).value })}
            />
          </Field>
          <Field label="Source">
            <Select
              data-testid="activity-source"
              class="w-36"
              value={filters.source}
              onChange={(e: Event) => set({ source: (e.target as HTMLSelectElement).value })}
            >
              <option value="">All sources</option>
              <option value="event">Events</option>
              <option value="email">Email</option>
              <option value="send">Sends</option>
            </Select>
          </Field>
          <Field label="Outcome">
            <Select
              data-testid="activity-outcome"
              class="w-36"
              value={filters.outcome}
              onChange={(e: Event) => set({ outcome: (e.target as HTMLSelectElement).value })}
            >
              <option value="">All outcomes</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="info">Info</option>
            </Select>
          </Field>
          <Field label="Type" class="min-w-[10rem] flex-1">
            <Input
              data-testid="activity-type"
              placeholder="e.g. purchase, bounce, delivery"
              value={filters.type}
              onInput={(e: Event) => set({ type: (e.target as HTMLInputElement).value })}
            />
          </Field>
          <div class="flex gap-2">
            <Button data-testid="activity-apply" onClick={apply}>
              Apply
            </Button>
            <Button data-testid="activity-reset" variant="ghost" onClick={reset}>
              Reset
            </Button>
          </div>
        </div>
      </Card>

      {selected.size > 0 ? (
        <div data-testid="activity-bulk-bar" class="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm">
          <span class="font-medium text-ink-800">{selected.size} selected</span>
          <Button
            data-testid="activity-retry-selected"
            size="sm"
            loading={[...selected].some((id) => retrying.has(id))}
            onClick={retrySelected}
          >
            Retry selected
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {rows === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState>No activity matches these filters.</EmptyState>
      ) : (
        <Card class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th class="w-8 px-4 py-2.5">
                  <input
                    type="checkbox"
                    data-testid="activity-select-all"
                    aria-label="Select all retryable"
                    checked={allRetryableSelected}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th class="w-8 px-4 py-2.5" />
                <th class="px-4 py-2.5 font-semibold">When</th>
                <th class="px-4 py-2.5 font-semibold">Source</th>
                <th class="px-4 py-2.5 font-semibold">Type</th>
                <th class="px-4 py-2.5 font-semibold">Outcome</th>
                <th class="px-4 py-2.5 font-semibold">Profile</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-stone-100">
              {rows.map((r, i) => {
                const expandable = !!r.detail;
                const isOpen = open.has(i);
                return (
                  <Fragment key={i}>
                    <tr
                      data-testid="activity-row"
                      class={`hover:bg-stone-50/70 ${expandable ? 'cursor-pointer' : ''} ${isOpen ? 'bg-stone-50/70' : ''}`}
                      onClick={expandable ? () => toggle(i) : undefined}
                    >
                      <td class="px-4 py-2.5" onClick={(e: Event) => e.stopPropagation()}>
                        {r.retryable && r.ref_id ? (
                          <input
                            type="checkbox"
                            data-testid="activity-select"
                            aria-label="Select for retry"
                            checked={selected.has(r.ref_id)}
                            onChange={() => toggleSelect(r.ref_id!)}
                          />
                        ) : null}
                      </td>
                      <td class="px-4 py-2.5 text-stone-400">
                        {expandable ? (
                          <span data-testid="activity-expand" class={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                        ) : null}
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-stone-500">{fmt(r.at)}</td>
                      <td class="px-4 py-2.5">
                        <Badge tone="neutral">{r.source}</Badge>
                      </td>
                      <td class="px-4 py-2.5 font-medium text-ink-900">{r.type}</td>
                      <td class="px-4 py-2.5">
                        <Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge>
                      </td>
                      <td class="px-4 py-2.5 text-stone-600" onClick={(e: Event) => e.stopPropagation()}>
                        {r.profile_id ? (
                          <button
                            type="button"
                            data-testid="activity-profile-link"
                            class="text-brand-600 hover:text-brand-700 hover:underline"
                            onClick={() => navigate(`/profiles/${r.profile_id}`)}
                          >
                            {r.email ?? r.profile_id}
                          </button>
                        ) : (
                          (r.email ?? '—')
                        )}
                      </td>
                    </tr>
                    {expandable && isOpen ? (
                      <tr data-testid="activity-detail-row" class="bg-stone-50/40">
                        <td colSpan={2} />
                        <td colSpan={5} class="px-4 pb-4 pt-1">
                          <JsonView value={r.detail} bare />
                          {r.retryable && r.ref_id ? (
                            <div class="mt-3">
                              <Button
                                data-testid="activity-retry"
                                variant="secondary"
                                size="sm"
                                loading={retrying.has(r.ref_id)}
                                disabled={retrying.has(r.ref_id)}
                                onClick={() => retrySingle(r)}
                              >
                                Retry this send
                              </Button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
