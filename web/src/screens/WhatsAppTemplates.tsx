// WhatsApp message TEMPLATES management (CLAUDE.md §10): create/submit templates to Meta
// for approval, track their status (PENDING/APPROVED/REJECTED), and delete them — all from
// the Asset management "WhatsApp templates" tab. This is a LIVE proxy to the Meta Graph API
// (the server uses the company's WABA id + decrypted token); the app does NOT store the
// templates, Meta does. An approved template is then referenced by name in a WhatsApp
// broadcast/automation send. Requires the company's WhatsApp credentials + WABA id (Company
// settings → Sending).
import { useEffect, useState } from 'preact/hooks';
import { api, sessionStore } from '../store/session.js';
import { useStore } from '../store/store.js';
import { Badge, Button, Card, EmptyState, Field, Input, DirectionalTextarea, Select, ActionMenu, type ActionMenuItem, toneFor } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';
import { askConfirm } from '../ui/dialog.tsx';

interface WaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  body: string;
  variableCount: number;
}

/** Count {{1}},{{2}}… placeholders in a body (to prompt for example values). */
function countVars(text: string): number {
  const set = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) set.add(m[1]!);
  return set.size;
}

const STATUS_TONE: Record<string, 'success' | 'warn' | 'danger' | 'neutral'> = {
  APPROVED: 'success',
  PENDING: 'warn',
  IN_APPEAL: 'warn',
  REJECTED: 'danger',
  PAUSED: 'neutral',
  DISABLED: 'neutral',
};

export function WhatsAppTemplatesPanel() {
  const session = useStore(sessionStore);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  // Create form.
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en_US');
  const [category, setCategory] = useState('MARKETING');
  const [body, setBody] = useState('');
  const [examples, setExamples] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    if (!session.workspaceId) return;
    setLoading(true);
    setLoadError('');
    try {
      const r = await api.get<{ configured: boolean; templates: WaTemplate[] }>('/whatsapp/templates');
      setConfigured(r.configured);
      setTemplates(r.templates ?? []);
    } catch (e) {
      setConfigured(true);
      setTemplates([]);
      setLoadError((e as { error?: string })?.error ?? 'Could not load templates from Meta.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.workspaceId]);

  // Keep the example inputs in sync with the number of {{n}} variables in the body.
  const varCount = countVars(body);
  useEffect(() => {
    setExamples((ex) => {
      const next = ex.slice(0, varCount);
      while (next.length < varCount) next.push('');
      return next;
    });
  }, [varCount]);

  const create = async () => {
    const nm = name.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(nm)) {
      showToast('Template name: lowercase letters, digits, and underscores only.', { tone: 'error' });
      return;
    }
    if (!body.trim()) {
      showToast('Add a message body.', { tone: 'error' });
      return;
    }
    setCreating(true);
    try {
      await api.post('/whatsapp/templates', {
        body: { name: nm, language: language.trim(), category, body: body.trim(), examples },
      });
      showToast('Template submitted to Meta for approval.', { tone: 'success' });
      setName('');
      setBody('');
      setExamples([]);
      await load();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not submit the template.', { tone: 'error' });
    } finally {
      setCreating(false);
    }
  };

  const remove = async (t: WaTemplate) => {
    const ok = await askConfirm({
      title: 'Delete WhatsApp template?',
      message: `“${t.name}” will be deleted from Meta (all its language versions). Sends referencing it will fail.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/whatsapp/templates/${encodeURIComponent(t.name)}`);
      showToast('Template deleted.', { tone: 'success' });
      await load();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not delete the template.', { tone: 'error' });
    }
  };

  // Not configured (no WABA id) → prompt to add credentials.
  if (configured === false) {
    return (
      <section data-testid="whatsapp-templates-screen">
        <EmptyState>
          <div data-testid="whatsapp-templates-unconfigured" class="space-y-1">
            <p>Connect WhatsApp to manage templates.</p>
            <p class="text-xs">
              Add your WhatsApp Business account id (WABA) + access token in <strong>Company settings → Sending →
              WhatsApp</strong>, then reload.
            </p>
          </div>
        </EmptyState>
      </section>
    );
  }

  return (
    <section data-testid="whatsapp-templates-screen">
      <p class="mb-4 text-sm text-stone-500">
        Message templates are created + approved by Meta, then referenced by name in a WhatsApp broadcast/automation
        send. Business-initiated WhatsApp <strong>requires an approved template</strong>. Approval usually takes minutes
        to a few hours.
      </p>

      {/* Create form */}
      <Card class="mb-4 p-4">
        <div class="space-y-3">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Name (lowercase_with_underscores)">
              <Input
                data-testid="wa-tpl-name"
                class="font-mono text-sm"
                placeholder="order_update"
                value={name}
                onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Language">
              <Input
                data-testid="wa-tpl-language"
                class="font-mono text-sm"
                placeholder="en_US"
                value={language}
                onInput={(e: Event) => setLanguage((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Category">
              <Select data-testid="wa-tpl-category" value={category} onChange={(e: Event) => setCategory((e.target as HTMLSelectElement).value)}>
                <option value="MARKETING">Marketing</option>
                <option value="UTILITY">Utility</option>
                <option value="AUTHENTICATION">Authentication</option>
              </Select>
            </Field>
          </div>
          <Field label="Body — use {{1}}, {{2}}… for variables">
            <DirectionalTextarea
              data-testid="wa-tpl-body"
              testIdPrefix="wa-tpl-dir"
              storageKey="wa-tpl-body"
              rows={3}
              placeholder={'Hi {{1}}, your order {{2}} has shipped!'}
              value={body}
              onInput={(e: Event) => setBody((e.target as HTMLTextAreaElement).value)}
            />
          </Field>
          {varCount > 0 ? (
            <div class="space-y-2">
              <p class="text-xs text-stone-500">Meta requires an EXAMPLE value for each variable (used only for review):</p>
              {examples.map((ex, i) => (
                <div data-testid="wa-tpl-example-row" key={i} class="flex items-center gap-2">
                  <span class="w-10 shrink-0 font-mono text-sm text-stone-500">{`{{${i + 1}}}`}</span>
                  <Input
                    data-testid="wa-tpl-example"
                    class="min-w-0 flex-1 text-sm"
                    placeholder="e.g. Ada"
                    value={ex}
                    onInput={(e: Event) => setExamples((xs) => xs.map((x, j) => (j === i ? (e.target as HTMLInputElement).value : x)))}
                  />
                </div>
              ))}
            </div>
          ) : null}
          <div class="flex justify-end">
            <Button data-testid="wa-tpl-submit" disabled={creating || !name.trim() || !body.trim()} onClick={create}>
              {creating ? 'Submitting…' : 'Submit for approval'}
            </Button>
          </div>
        </div>
      </Card>

      <div class="mb-2 flex items-center justify-between">
        <span class="text-xs font-semibold uppercase tracking-wide text-stone-500">Your templates</span>
        <Button data-testid="wa-tpl-refresh" variant="secondary" size="sm" onClick={load}>
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </Button>
      </div>
      {loadError ? <p data-testid="wa-tpl-error" class="mb-2 text-sm text-rose-600">{loadError}</p> : null}

      {templates.length ? (
        <ul data-testid="wa-templates-list" class="space-y-2">
          {templates.map((t) => (
            <li
              data-testid="wa-template-item"
              data-wa-template-name={t.name}
              key={`${t.name}:${t.language}`}
              class="flex items-start justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card"
            >
              <span class="flex min-w-0 flex-col">
                <span class="flex items-center gap-2">
                  <span class="truncate font-mono font-medium text-ink-900">{t.name}</span>
                  <Badge data-testid="wa-template-status" tone={STATUS_TONE[t.status] ?? toneFor(t.status)}>{t.status}</Badge>
                  <span class="text-xs text-stone-400">{t.language} · {t.category}</span>
                </span>
                <span class="mt-0.5 line-clamp-2 whitespace-pre-wrap text-sm text-stone-600">{t.body}</span>
                {t.variableCount > 0 ? <span class="mt-0.5 text-xs text-stone-500">{t.variableCount} variable(s)</span> : null}
              </span>
              <span class="shrink-0">
                <ActionMenu
                  data-testid="wa-template-actions"
                  items={[
                    { label: 'Delete', onSelect: () => remove(t), danger: true, 'data-testid': 'wa-template-delete' } satisfies ActionMenuItem,
                  ]}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="wa-templates-list">
          <EmptyState>{loadError ? 'Could not load templates.' : 'No templates yet — submit your first above.'}</EmptyState>
        </div>
      )}
    </section>
  );
}
