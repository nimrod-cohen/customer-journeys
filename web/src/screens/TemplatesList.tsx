// Asset management (§11/§12): one screen, two tabs —
//   • Email templates: the library list (design/edit/clone-source for broadcasts)
//   • Image gallery: the SAME AssetManagerPanel used by the Select-Asset modal,
//     embedded for pure management (folders, upload, rename, drag-move, delete).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Button, Card, PageHeader, EmptyState } from '../ui/kit.js';
import { AssetManagerPanel } from '../email-designer/AssetManager.tsx';

interface Template {
  id: string;
  name: string;
  updated_at: string | null;
}

function fmtDate(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function TemplatesList() {
  const [tab, setTab] = useState<'templates' | 'gallery'>('templates');
  const [templates, setTemplates] = useState<Template[] | null>(null);

  useEffect(() => {
    void api.get<{ templates: Template[] }>('/templates').then((r) => setTemplates(r.templates));
  }, []);

  return (
    <section data-testid="templates-screen">
      <PageHeader
        title="Asset management"
        subtitle="Email templates and the image gallery your emails are built from."
        actions={
          tab === 'templates' ? (
            <Button data-testid="new-template" onClick={() => navigate('/editor')}>
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
          data-testid="assets-tab-gallery"
          class={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${
            tab === 'gallery' ? 'border-brand-500 text-ink-900' : 'border-transparent text-stone-500 hover:text-ink-800'
          }`}
          onClick={() => setTab('gallery')}
        >
          Image gallery
        </button>
      </div>

      {tab === 'gallery' ? (
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
                <span class="truncate font-medium text-ink-900">{t.name}</span>
                {t.updated_at ? <span class="text-xs text-stone-500">updated {fmtDate(t.updated_at)}</span> : null}
              </span>
              <Button data-testid="template-edit" variant="secondary" size="sm" onClick={() => navigate(`/editor/${t.id}`)}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="template-list">
          <EmptyState>No templates yet — create one with “New template”.</EmptyState>
        </div>
      )}
    </section>
  );
}
