// Topics (CLAUDE.md topic-subscriptions): the workspace's subscription topics.
// A topic can be attached to a broadcast/automation; a recipient unsubscribed from
// it (via the preference center) is skipped at send. This is the admin panel:
// create, rename, archive/unarchive, and delete topics — it lives as a TAB inside
// Workspace settings (owner-managed config; marketers still pick topics in the
// broadcast/automation selector via the manage_content GET). Re-fetches on the
// active workspace so a switch re-scopes in place.
import { useEffect, useState } from 'preact/hooks';
import { api, sessionStore } from '../store/session.js';
import { useStore } from '../store/store.js';
import { Badge, Button, Card, EmptyState, Input, ActionMenu, type ActionMenuItem } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';
import { askConfirm, askText } from '../ui/dialog.tsx';

interface Topic {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
}

/** The topics management panel — rendered inside the Workspace settings "Topics" tab. */
export function TopicsPanel() {
  const session = useStore(sessionStore);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Topic-based subscription management (default ON). When OFF (or no active
  // topics), the recipient's preference link shows the plain unsubscribe page.
  const [topicsEnabled, setTopicsEnabled] = useState(true);
  const [savingEnabled, setSavingEnabled] = useState(false);

  const load = async (includeArchived: boolean) => {
    if (!session.workspaceId) {
      setTopics([]);
      return;
    }
    try {
      const r = await api.get<{ topics: Topic[] }>(
        `/topics${includeArchived ? '?include_archived=true' : ''}`,
      );
      setTopics(r.topics);
    } catch {
      setTopics([]);
    }
  };

  useEffect(() => {
    void load(showArchived);
  }, [session.workspaceId, showArchived]);

  useEffect(() => {
    void api
      .get<{ settings: { topics_enabled?: boolean } }>('/workspace/settings')
      .then((r) => setTopicsEnabled(r.settings.topics_enabled !== false))
      .catch(() => {});
  }, [session.workspaceId]);

  const toggleTopicsEnabled = async () => {
    if (savingEnabled) return;
    const next = !topicsEnabled;
    setTopicsEnabled(next); // optimistic
    setSavingEnabled(true);
    try {
      await api.put('/workspace/settings', { body: { topics_enabled: next } });
    } catch {
      setTopicsEnabled(!next); // revert
      showToast('Could not update topic management.', { tone: 'error' });
    } finally {
      setSavingEnabled(false);
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await api.post('/topics', { body: { name: trimmed, description: description.trim() || null } });
      setName('');
      setDescription('');
      showToast('Topic created.', { tone: 'success' });
      await load(showArchived);
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not create the topic.', { tone: 'error' });
    }
  };

  const rename = async (t: Topic) => {
    const next = await askText({ title: 'Rename topic', label: 'Name', initial: t.name });
    if (next === null || next.trim() === '' || next.trim() === t.name) return;
    try {
      await api.patch(`/topics/${t.id}`, { body: { name: next.trim() } });
      showToast('Topic renamed.', { tone: 'success' });
      await load(showArchived);
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not rename the topic.', { tone: 'error' });
    }
  };

  const setArchived = async (t: Topic, archived: boolean) => {
    try {
      await api.patch(`/topics/${t.id}`, { body: { archived } });
      showToast(archived ? 'Topic archived.' : 'Topic restored.', { tone: 'success' });
      await load(showArchived);
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not update the topic.', { tone: 'error' });
    }
  };

  const remove = async (t: Topic) => {
    const ok = await askConfirm({
      title: 'Delete topic?',
      message: `“${t.name}” will be removed. Recipients' opt-out history for it is also cleared.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/topics/${t.id}`);
      showToast('Topic deleted.', { tone: 'success' });
      await load(showArchived);
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not delete the topic.', { tone: 'error' });
    }
  };

  return (
    <section data-testid="topics-screen">
      <Card class="mb-4 flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="text-base font-bold text-ink-900">Use topic-based subscription management</h2>
          <p class="mt-1 text-sm text-stone-500">
            When on, the recipient's preference link lets them opt out of individual topics &amp; channels. When off (or
            with no active topics), it shows a plain unsubscribe page.
          </p>
        </div>
        <button
          data-testid="topics-enabled-toggle"
          type="button"
          role="switch"
          aria-checked={topicsEnabled}
          disabled={savingEnabled}
          onClick={toggleTopicsEnabled}
          class={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${
            topicsEnabled ? 'bg-brand-500' : 'bg-stone-300'
          }`}
        >
          <span
            class={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
              topicsEnabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </Card>

      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p class="text-sm text-stone-500">
          Subscription topics recipients can opt out of individually (via the preference center).
        </p>
        <label class="flex items-center gap-2 text-sm text-stone-600">
          <input
            type="checkbox"
            data-testid="topics-show-archived"
            checked={showArchived}
            onChange={(e) => setShowArchived((e.target as HTMLInputElement).checked)}
          />
          Show archived
        </label>
      </div>

      <Card class="mb-4 p-4">
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex-1 min-w-[180px]">
            <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-500">Name</label>
            <Input
              data-testid="topic-name"
              placeholder="e.g. Product news"
              value={name}
              onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="flex-1 min-w-[180px]">
            <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-500">
              Description (optional)
            </label>
            <Input
              data-testid="topic-description"
              placeholder="What this topic is about"
              value={description}
              onInput={(e: Event) => setDescription((e.target as HTMLInputElement).value)}
            />
          </div>
          <Button data-testid="topic-create" disabled={!name.trim()} onClick={create}>
            + Add topic
          </Button>
        </div>
      </Card>

      <Card class="overflow-x-auto">
        <table class="w-full text-sm" data-testid="topics-list">
          <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th class="px-4 py-2.5 font-semibold">Name</th>
              <th class="px-4 py-2.5 font-semibold">Description</th>
              <th class="px-4 py-2.5 font-semibold">Status</th>
              <th class="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody class="divide-y divide-stone-100">
            {topics.map((t) => (
              <tr data-testid="topic-row" data-topic-id={t.id} key={t.id} class="hover:bg-stone-50/70">
                <td class="px-4 py-2.5 font-medium text-ink-900">{t.name}</td>
                <td class="px-4 py-2.5 text-stone-600">{t.description ?? '—'}</td>
                <td class="px-4 py-2.5">
                  <Badge tone={t.archived ? 'neutral' : 'success'}>{t.archived ? 'Archived' : 'Active'}</Badge>
                </td>
                <td class="px-4 py-2.5 text-right">
                  <ActionMenu
                    data-testid="topic-actions"
                    items={[
                      {
                        label: 'Rename',
                        onSelect: () => rename(t),
                        'data-testid': 'topic-rename',
                      } satisfies ActionMenuItem,
                      t.archived
                        ? ({
                            label: 'Restore',
                            onSelect: () => setArchived(t, false),
                            'data-testid': 'topic-restore',
                          } satisfies ActionMenuItem)
                        : ({
                            label: 'Archive',
                            onSelect: () => setArchived(t, true),
                            'data-testid': 'topic-archive',
                          } satisfies ActionMenuItem),
                      {
                        label: 'Delete',
                        onSelect: () => remove(t),
                        danger: true,
                        'data-testid': 'topic-delete',
                      } satisfies ActionMenuItem,
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {topics.length === 0 ? (
          <div class="p-4">
            <EmptyState>No topics yet — add your first above.</EmptyState>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
