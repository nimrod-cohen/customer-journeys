// Activity log (§12): a unified, filterable feed of everything that happens in
// the workspace — behavioural events, email/delivery events, and sends. Filters
// (datetime range, source, outcome, type) are applied SERVER-SIDE (scoped to the
// token's workspace). Read-only.
import { useEffect, useState } from 'preact/hooks';
import { api, sessionStore } from '../store/session.js';
import { useStore } from '../store/store.js';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select } from '../ui/kit.js';
import { CollapsibleJson } from '../ui/JsonView.js';

interface ActivityRow {
  at: string;
  source: 'event' | 'email' | 'send';
  type: string;
  outcome: 'success' | 'failure' | 'info';
  profile_id: string | null;
  detail: string | null;
  email: string | null;
}

interface Filters {
  from: string;
  to: string;
  source: string;
  outcome: string;
  type: string;
}

const EMPTY_FILTERS: Filters = { from: '', to: '', source: '', outcome: '', type: '' };

function outcomeTone(o: string): 'success' | 'danger' | 'neutral' {
  return o === 'success' ? 'success' : o === 'failure' ? 'danger' : 'neutral';
}
function fmt(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
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
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

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
  };

  // Initial load + reload when the active workspace changes (re-scope in place).
  useEffect(() => {
    void load(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.workspaceId]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const apply = () => void load(filters);
  const reset = () => {
    setFilters(EMPTY_FILTERS);
    void load(EMPTY_FILTERS);
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

      {rows === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState>No activity matches these filters.</EmptyState>
      ) : (
        <Card class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th class="px-4 py-2.5 font-semibold">When</th>
                <th class="px-4 py-2.5 font-semibold">Source</th>
                <th class="px-4 py-2.5 font-semibold">Type</th>
                <th class="px-4 py-2.5 font-semibold">Outcome</th>
                <th class="px-4 py-2.5 font-semibold">Profile</th>
                <th class="px-4 py-2.5 font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-stone-100">
              {rows.map((r, i) => (
                <tr data-testid="activity-row" key={i} class="hover:bg-stone-50/70">
                  <td class="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-stone-500">{fmt(r.at)}</td>
                  <td class="px-4 py-2.5">
                    <Badge tone="neutral">{r.source}</Badge>
                  </td>
                  <td class="px-4 py-2.5 font-medium text-ink-900">{r.type}</td>
                  <td class="px-4 py-2.5">
                    <Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge>
                  </td>
                  <td class="px-4 py-2.5 text-stone-600">{r.email ?? '—'}</td>
                  <td class="px-4 py-2.5 align-top font-mono text-xs text-stone-500">
                    <CollapsibleJson value={r.detail} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
