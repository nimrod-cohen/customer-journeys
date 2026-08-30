// Asset management (§11/§12): one screen, two tabs —
//   • Email templates: the library list (design/edit/clone-source for broadcasts)
//   • Image gallery: the SAME AssetManagerPanel used by the Select-Asset modal,
//     embedded for pure management (folders, upload, rename, drag-move, delete).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { clearEditorReturn } from '../store/editorReturn.js';
import { Button, Card, PageHeader, EmptyState, ActionMenu, Badge, Drawer, Field, Input } from '../ui/kit.js';
import { formatDateTime } from '../ui/datetime.js';
import { askConfirm } from '../ui/dialog.tsx';
import { showToast } from '../ui/toast.js';
import { AssetManagerPanel } from '../email-designer/AssetManager.tsx';
import { TextTemplatesPanel } from './TextTemplates.tsx';
import { WhatsAppTemplatesPanel } from './WhatsAppTemplates.tsx';

interface Template {
  id: string;
  name: string;
  /** Set = reachable from the transactional API by this stable key. */
  transactional_key: string | null;
  updated_at: string | null;
}

function fmtDate(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : formatDateTime(d);
}

export function TemplatesList() {
  const [tab, setTab] = useState<'templates' | 'text' | 'whatsapp' | 'gallery'>('templates');
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState('');
  // The template whose transactional key is being edited, plus the draft value.
  const [keyTarget, setKeyTarget] = useState<Template | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyError, setKeyError] = useState('');

  useEffect(() => {
    void api.get<{ templates: Template[] }>('/templates').then((r) => setTemplates(r.templates));
  }, []);

  const deleteTemplate = async (t: Template): Promise<void> => {
    const ok = await askConfirm({
      title: 'Delete template',
      message: `Delete “${t.name}”? This can't be undone. Broadcasts and automations keep their own copy, so they're unaffected.`,
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setError('');
    try {
      await api.del(`/templates/${t.id}`);
      setTemplates((list) => (list ?? []).filter((x) => x.id !== t.id));
    } catch (e) {
      // The client throws { status, error } on non-2xx (e.g. 409 in-use).
      const msg = (e as { error?: string })?.error ?? (e instanceof Error ? e.message : 'Could not delete the template.');
      setError(msg);
    }
  };

  const openKeyDrawer = (t: Template): void => {
    setKeyTarget(t);
    setKeyDraft(t.transactional_key ?? '');
    setKeyError('');
  };

  const saveKey = async (): Promise<void> => {
    if (!keyTarget) return;
    setKeyError('');
    const next = keyDraft.trim();
    try {
      const res = await api.put<{ transactional_key: string | null }>(
        `/templates/${keyTarget.id}/transactional-key`,
        { body: { transactional_key: next === '' ? null : next } },
      );
      setTemplates((list) =>
        (list ?? []).map((x) => (x.id === keyTarget.id ? { ...x, transactional_key: res.transactional_key } : x)),
      );
      setKeyTarget(null);
      showToast(res.transactional_key ? `API key set to “${res.transactional_key}”.` : 'API key removed.');
    } catch (e) {
      // 409 (key in use) and 400 (bad characters) both carry a message worth showing.
      setKeyError((e as { error?: string })?.error ?? 'Could not save the key.');
    }
  };

  return (
    <section data-testid="templates-screen">
      <PageHeader
        title="Asset management"
        subtitle="Email templates and the image gallery your emails are built from."
        actions={
          tab === 'templates' ? (
            <Button
              data-testid="new-template"
              onClick={() => {
                clearEditorReturn();
                navigate('/editor');
              }}
            >
              New template
            </Button>
          ) : undefined
        }
      />

      {/* Tabs */}
      <div class="mb-5 flex gap-1 border-b border-stone-200">
        <button
          type="button"
          data-testid="assets-tab-templates"
          class={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${
            tab === 'templates' ? 'border-brand-500 text-ink-900' : 'border-transparent text-stone-500 hover:text-ink-800'
          }`}
          onClick={() => setTab('templates')}
        >
          Email templates
        </button>
        <button
          type="button"
          data-testid="assets-tab-text"
          class={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${
            tab === 'text' ? 'border-brand-500 text-ink-900' : 'border-transparent text-stone-500 hover:text-ink-800'
          }`}
          onClick={() => setTab('text')}
        >
          SMS templates
        </button>
        <button
          type="button"
          data-testid="assets-tab-whatsapp"
          class={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${
            tab === 'whatsapp' ? 'border-brand-500 text-ink-900' : 'border-transparent text-stone-500 hover:text-ink-800'
          }`}
          onClick={() => setTab('whatsapp')}
        >
          WhatsApp templates
        </button>
        <button
          type="button"
          data-testid="assets-tab-gallery"
          class={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${
            tab === 'gallery' ? 'border-brand-500 text-ink-900' : 'border-transparent text-stone-500 hover:text-ink-800'
          }`}
          onClick={() => setTab('gallery')}
        >
          Image gallery
        </button>
      </div>

      {tab === 'templates' && error ? (
        <p data-testid="templates-error" class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {tab === 'text' ? (
        <TextTemplatesPanel />
      ) : tab === 'whatsapp' ? (
        <WhatsAppTemplatesPanel />
      ) : tab === 'gallery' ? (
        <Card class="flex h-[70vh] flex-col overflow-hidden p-2">
          <AssetManagerPanel />
        </Card>
      ) : templates === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : templates.length ? (
        <ul data-testid="template-list" class="space-y-2">
          {templates.map((t) => (
            <li
              data-testid="template-item"
              key={t.id}
              class="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card"
            >
              <span class="flex min-w-0 flex-col">
                <span class="flex min-w-0 items-center gap-2">
                  <span class="truncate font-medium text-ink-900">{t.name}</span>
                  {/* The key is the integrator's contract, so show it on the row itself. */}
                  {t.transactional_key ? (
                    <Badge tone="success" data-testid="template-transactional-badge">
                      API: {t.transactional_key}
                    </Badge>
                  ) : null}
                </span>
                {t.updated_at ? <span class="text-xs text-stone-500">updated {fmtDate(t.updated_at)}</span> : null}
              </span>
              <span class="flex shrink-0 items-center gap-2">
                <ActionMenu
                  data-testid="template-actions"
                  items={[
                    {
                      label: 'Edit design',
                      'data-testid': 'template-edit',
                      onSelect: () => {
                        clearEditorReturn();
                        navigate(`/editor/${t.id}`);
                      },
                    },
                    {
                      label: t.transactional_key ? 'Transactional API key…' : 'Use for transactional API…',
                      'data-testid': 'template-transactional-key',
                      onSelect: () => openKeyDrawer(t),
                    },
                    {
                      label: 'Delete',
                      danger: true,
                      'data-testid': 'template-delete',
                      onSelect: () => deleteTemplate(t),
                    },
                  ]}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="template-list">
          <EmptyState>No templates yet — create one with “New template”.</EmptyState>
        </div>
      )}
      <Drawer
        open={keyTarget !== null}
        onClose={() => setKeyTarget(null)}
        testId="transactional-key-drawer"
        title="Transactional API key"
        subtitle={keyTarget ? keyTarget.name : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setKeyTarget(null)}>
              Cancel
            </Button>
            <Button data-testid="transactional-key-save" onClick={saveKey}>
              Save
            </Button>
          </>
        }
      >
        <p class="mb-4 text-sm text-stone-600">
          Give this template a stable key and your application can send it over the API, passing values that fill in
          the subject and body. Because the key is what your code refers to, you can redesign the template — or move
          the key to a different one — without changing your code.
        </p>
        <Field label="Key" hint="Lowercase letters, digits, dashes and underscores. Leave blank to remove.">
          <Input
            data-testid="transactional-key-input"
            value={keyDraft}
            placeholder="otp"
            onInput={(e) => setKeyDraft((e.target as HTMLInputElement).value)}
          />
        </Field>
        {keyError ? (
          <p data-testid="transactional-key-error" class="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {keyError}
          </p>
        ) : null}
        {keyDraft.trim() ? (
          <div class="mt-5">
            <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Send it like this</p>
            <pre class="overflow-x-auto rounded-lg bg-stone-900 p-3 text-xs leading-relaxed text-stone-100">
{`POST /v1/send
Authorization: Bearer <your API key>

{
  "template": "${keyDraft.trim()}",
  "to": "someone@example.com",
  "data": { "code": "123456" }
}`}
            </pre>
            <p class="mt-2 text-xs text-stone-500">
              Reference the values in the subject or body as <code>{'{{data.code}}'}</code>. Recipients who
              unsubscribed are skipped unless the request sets <code>ignore_unsubscribe</code>.
            </p>
          </div>
        ) : null}
      </Drawer>
    </section>
  );
}
