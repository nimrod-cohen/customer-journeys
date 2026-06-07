// SegmentsList (§12): the Segments home — a searchable list of the workspace's
// segments, with actions to create a new one or edit an existing one. Building
// and editing happen on a DESIGNATED screen (SegmentBuilder at /segments/new and
// /segments/:id); this screen is read-only + navigation. It re-fetches on mount,
// so returning here after a save always shows the latest list (reactive).
import { useEffect, useState } from 'preact/hooks';
import { api, sessionStore } from '../store/session.js';
import { useStore } from '../store/store.js';
import { navigate } from '../router.js';
import { Badge, Button, Card, EmptyState, Input, PageHeader, toneFor } from '../ui/kit.js';

interface Segment {
  id: string;
  name: string;
  kind: string;
  status: string;
}

export function SegmentsList() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [q, setQ] = useState('');
  // Re-fetch on the active workspace too: switching workspaces must re-scope the
  // list in place (the route stays /segments, so this screen does not remount).
  const session = useStore(sessionStore);
  useEffect(() => {
    let cancelled = false;
    if (!session.workspaceId) {
      setSegments([]);
      return;
    }
    void api
      .get<{ segments: Segment[] }>('/segments')
      .then((r) => {
        if (!cancelled) setSegments(r.segments);
      })
      .catch(() => {
        if (!cancelled) setSegments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session.workspaceId]);

  const needle = q.trim().toLowerCase();
  const shown = needle ? segments.filter((s) => s.name.toLowerCase().includes(needle)) : segments;

  return (
    <section data-testid="segments-list">
      <PageHeader
        title="Segments"
        subtitle="Rule-based and manual audiences in this workspace."
        actions={
          <Button data-testid="new-segment" onClick={() => navigate('/segments/new')}>
            + New segment
          </Button>
        }
      />

      <div class="mb-4 max-w-sm">
        <Input
          data-testid="segment-search"
          type="search"
          placeholder="Search segments by name…"
          value={q}
          onInput={(e: Event) => setQ((e.target as HTMLInputElement).value)}
        />
      </div>

      <Card class="overflow-x-auto">
        <table class="w-full text-sm" data-testid="segment-list">
          <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th class="px-4 py-2.5 font-semibold">Name</th>
              <th class="px-4 py-2.5 font-semibold">Kind</th>
              <th class="px-4 py-2.5 font-semibold">Status</th>
              <th class="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody class="divide-y divide-stone-100">
            {shown.map((s) => (
              <tr
                data-testid="segment-list-item"
                data-segment-id={s.id}
                key={s.id}
                onClick={() => navigate(`/segments/${s.id}`)}
                class="cursor-pointer hover:bg-stone-50/70"
              >
                <td class="px-4 py-2.5 font-medium text-ink-900">{s.name}</td>
                <td class="px-4 py-2.5">
                  <Badge tone={s.kind === 'manual' ? 'neutral' : 'success'}>{s.kind}</Badge>
                </td>
                <td class="px-4 py-2.5">
                  <Badge tone={toneFor(s.status)}>{s.status}</Badge>
                </td>
                <td class="px-4 py-2.5 text-right">
                  <button
                    data-testid="segment-edit"
                    class="btn-ghost btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/segments/${s.id}`);
                    }}
                  >
                    Edit →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <div class="p-4">
            <EmptyState>
              {segments.length === 0 ? 'No segments yet — create your first.' : 'No segments match your search.'}
            </EmptyState>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
