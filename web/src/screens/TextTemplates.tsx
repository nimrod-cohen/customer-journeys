// Text templates (CLAUDE.md text_templates): a reusable plain-text message
// library usable for BOTH SMS and WhatsApp (one template serves both mediums).
// Picking a template in the broadcast/campaign text-body step COPIES its body
// into the send (copy-on-select, no live reference) — this is the LIBRARY admin
// (create / edit name+body / delete). It lives as a TAB on the Asset management
// screen, beside Email templates. Re-fetches on the active workspace.
import { useEffect, useState } from 'preact/hooks';
import { api, sessionStore } from '../store/session.js';
import { useStore } from '../store/store.js';
import { Button, Card, EmptyState, Input, DirectionalTextarea, ActionMenu, type ActionMenuItem } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';
import { askConfirm } from '../ui/dialog.tsx';

interface TextTemplate {
  id: string;
  name: string;
  body: string;
  updated_at: string | null;
}

function fmtDate(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** The text-template library — rendered inside the Asset management "Text templates" tab. */
export function TextTemplatesPanel() {
  const session = useStore(sessionStore);
  const [templates, setTemplates] = useState<TextTemplate[]>([]);
  // The editor form doubles as create (editId === null) and edit (editId set).
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');

  const load = async () => {
    if (!session.workspaceId) {
      setTemplates([]);
      return;
    }
    try {
      const r = await api.get<{ templates: TextTemplate[] }>('/text-templates');
      setTemplates(r.templates);
    } catch {
      setTemplates([]);
    }
  };

  useEffect(() => {
    void load();
  }, [session.workspaceId]);

  const resetForm = () => {
    setEditId(null);
    setName('');
    setBody('');
  };

  const beginEdit = (t: TextTemplate) => {
    setEditId(t.id);
    setName(t.name);
    setBody(t.body);
  };

  const save = async () => {
    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    if (!trimmedName || !trimmedBody) return;
    try {
      if (editId) {
        await api.put(`/text-templates/${editId}`, { body: { name: trimmedName, body: trimmedBody } });
        showToast('Text template updated.', { tone: 'success' });
      } else {
        await api.post('/text-templates', { body: { name: trimmedName, body: trimmedBody } });
        showToast('Text template created.', { tone: 'success' });
      }
      resetForm();
      await load();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not save the template.', { tone: 'error' });
    }
  };

  const remove = async (t: TextTemplate) => {
    const ok = await askConfirm({
      title: 'Delete text template?',
      message: `“${t.name}” will be removed. Broadcasts and campaigns keep their own copied body, so they're unaffected.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/text-templates/${t.id}`);
      showToast('Text template deleted.', { tone: 'success' });
      if (editId === t.id) resetForm();
      await load();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not delete the template.', { tone: 'error' });
    }
  };

  return (
    <section data-testid="text-templates-screen">
      <p class="mb-4 text-sm text-stone-500">
        Reusable plain-text messages for SMS &amp; WhatsApp. Pick one when composing a text broadcast or a campaign send
        step to fill the message body. Use merge tags like{' '}
        <code class="rounded bg-stone-100 px-1">{'{{customer.first_name}}'}</code> to personalize.
      </p>

      <Card class="mb-4 p-4">
        <div class="space-y-3">
          {editId ? (
            <p class="text-xs font-semibold uppercase tracking-wide text-brand-600" data-testid="text-template-editing">
              Editing template
            </p>
          ) : null}
          <div>
            <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-500">Name</label>
            <Input
              data-testid="text-template-name"
              placeholder="e.g. Order shipped"
              value={name}
              onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-stone-500">Message body</label>
            <DirectionalTextarea
              data-testid="text-template-body"
              testIdPrefix="text-template-dir"
              storageKey="text-template-body"
              rows={3}
              placeholder={'Hi {{customer.first_name}}, your order has shipped!'}
              value={body}
              onInput={(e: Event) => setBody((e.target as HTMLTextAreaElement).value)}
            />
          </div>
          <div class="flex justify-end gap-2">
            {editId ? (
              <Button data-testid="text-template-cancel" variant="secondary" onClick={resetForm}>
                Cancel
              </Button>
            ) : null}
            <Button data-testid="text-template-create" disabled={!name.trim() || !body.trim()} onClick={save}>
              {editId ? 'Save changes' : '+ Add text template'}
            </Button>
          </div>
        </div>
      </Card>

      {templates.length ? (
        <ul data-testid="text-templates-list" class="space-y-2">
          {templates.map((t) => (
            <li
              data-testid="text-template-item"
              data-text-template-id={t.id}
              key={t.id}
              class="flex items-start justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card"
            >
              <span class="flex min-w-0 flex-col">
                <span class="truncate font-medium text-ink-900">{t.name}</span>
                <span class="mt-0.5 line-clamp-2 whitespace-pre-wrap text-sm text-stone-600">{t.body}</span>
                {t.updated_at ? <span class="mt-0.5 text-xs text-stone-500">updated {fmtDate(t.updated_at)}</span> : null}
              </span>
              <span class="shrink-0">
                <ActionMenu
                  data-testid="text-template-actions"
                  items={[
                    {
                      label: 'Edit',
                      onSelect: () => beginEdit(t),
                      'data-testid': 'text-template-edit',
                    } satisfies ActionMenuItem,
                    {
                      label: 'Delete',
                      onSelect: () => remove(t),
                      danger: true,
                      'data-testid': 'text-template-delete',
                    } satisfies ActionMenuItem,
                  ]}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="text-templates-list">
          <EmptyState>No text templates yet — add your first above.</EmptyState>
        </div>
      )}
    </section>
  );
}
