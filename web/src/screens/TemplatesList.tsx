// TemplatesList (§11/§12): the home for email templates. Lists the workspace's
// templates; "New template" opens the editor for a fresh one; "Edit" opens the
// editor for an existing one (/editor/:id). The editor is where the design + MJML
// live; this screen is where you find and manage them.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Button, PageHeader, EmptyState } from '../ui/kit.js';

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
  const [templates, setTemplates] = useState<Template[] | null>(null);

  useEffect(() => {
    void api.get<{ templates: Template[] }>('/templates').then((r) => setTemplates(r.templates));
  }, []);

  return (
    <section data-testid="templates-screen">
      <PageHeader
        title="Email templates"
        subtitle="Design reusable emails; broadcasts and campaigns send them."
        actions={
          <Button data-testid="new-template" onClick={() => navigate('/editor')}>
            New template
          </Button>
        }
      />

      {templates === null ? (
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
