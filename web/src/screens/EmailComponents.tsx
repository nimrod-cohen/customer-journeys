// Saved email components (a shared footer, header…): the library tab on the
// assets screen, and the editor for one component. A component is designed with
// the SAME EmailDesigner; saving it re-renders every email that links to it.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { ActionMenu, Badge, EmptyState, Field, Input, PageHeader } from '../ui/kit.js';
import { askConfirm } from '../ui/dialog.tsx';
import { showToast } from '../ui/toast.js';
import { EmailDesigner } from '../email-designer/EmailDesigner.tsx';
import { emptyDesign, isEmailDesign, type EmailDesign } from '../email-designer/model.js';

interface ComponentRow {
  id: string;
  name: string;
  design: EmailDesign;
  used_by?: number;
  updated_at?: string;
}

const usedLabel = (n: number): string => (n === 1 ? 'used in 1 email' : `used in ${n} emails`);

/** The Components tab: list, edit, delete. Components are created from a row in any email. */
export function EmailComponentsPanel(): JSX.Element {
  const [list, setList] = useState<ComponentRow[] | null>(null);
  useEffect(() => {
    void api.get<{ components: ComponentRow[] }>('/email-components').then((r) => setList(r.components));
  }, []);

  const remove = async (c: ComponentRow): Promise<void> => {
    const ok = await askConfirm({
      title: `Delete “${c.name}”?`,
      message: c.used_by
        ? `It is ${usedLabel(c.used_by)}. Those emails keep their current copy, but it will no longer update with the component.`
        : 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await api.del(`/email-components/${c.id}`);
    setList((l) => (l ?? []).filter((x) => x.id !== c.id));
    showToast('Component deleted', { tone: 'success' });
  };

  if (list === null) return <p class="text-sm text-stone-500">Loading…</p>;
  return (
    <div data-testid="components-panel">
      <p class="mb-3 text-sm text-stone-600">
        Reusable blocks, such as a footer with the unsubscribe link. To make one, select a row in any email and choose{' '}
        <b>Save as component</b>; add it to other emails from <b>Add → Saved components</b>. Editing a component updates every
        email that uses it.
      </p>
      {list.length === 0 ? (
        <EmptyState>No components yet.</EmptyState>
      ) : (
        <ul class="space-y-2">
          {list.map((c) => (
            <li
              key={c.id}
              data-testid="component-item"
              class="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-surface px-4 py-3 shadow-card"
            >
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate font-medium text-ink-900">◆ {c.name}</span>
                <Badge tone="neutral">{usedLabel(c.used_by ?? 0)}</Badge>
              </span>
              <ActionMenu
                data-testid="component-actions"
                items={[
                  { label: 'Edit', 'data-testid': 'component-edit', onSelect: () => navigate(`/components/${c.id}`) },
                  { label: 'Delete', danger: true, 'data-testid': 'component-delete', onSelect: () => remove(c) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const AUTOSAVE_MS = 800;

/** /components/:id — design one component; autosaves like the email editor. */
export function EmailComponentEditor({ id }: { id: string }): JSX.Element {
  const [name, setName] = useState('');
  const [design, setDesign] = useState<EmailDesign | null>(null);
  const [usedBy, setUsedBy] = useState(0);
  const [status, setStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const live = useRef<EmailDesign>(emptyDesign());
  const nameRef = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);

  useEffect(() => {
    void api
      .get<{ components: ComponentRow[] }>('/email-components')
      .then((r) => {
        const c = r.components.find((x) => x.id === id);
        if (!c) {
          navigate('/templates');
          return;
        }
        const d = isEmailDesign(c.design) ? c.design : emptyDesign();
        live.current = d;
        nameRef.current = c.name;
        setName(c.name);
        setUsedBy(c.used_by ?? 0);
        setDesign(d);
      })
      .catch(() => navigate('/templates'));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id]);

  const persist = async (): Promise<void> => {
    if (saving.current) await saving.current;
    if (!dirty.current) return;
    dirty.current = false;
    setStatus('saving');
    saving.current = api
      .put(`/email-components/${id}`, { body: { name: nameRef.current.trim() || 'Untitled', design: live.current } })
      .then(
        () => setStatus(dirty.current ? 'dirty' : 'saved'),
        () => {
          dirty.current = true;
          setStatus('error');
        },
      );
    await saving.current;
    saving.current = null;
  };

  const schedule = (): void => {
    dirty.current = true;
    setStatus('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(), AUTOSAVE_MS);
  };

  const back = async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    await persist();
    navigate('/templates/components');
  };

  return (
    <section data-testid="component-editor">
      <PageHeader
        title="Edit component"
        subtitle={`Changes save automatically and update every email that uses it (${usedLabel(usedBy)}).`}
        back={
          <button data-testid="component-back" class="btn-ghost btn-sm whitespace-nowrap" onClick={() => void back()}>
            ← Back to components
          </button>
        }
        actions={
          <div class="flex items-end gap-3">
            <Field label="Component name">
              <Input
                data-testid="component-name"
                value={name}
                onInput={(e: Event) => {
                  const v = (e.target as HTMLInputElement).value;
                  setName(v);
                  nameRef.current = v;
                  schedule();
                }}
              />
            </Field>
            <span data-testid="component-save-status" class="min-w-[5rem] pb-2 text-sm font-medium">
              {status === 'saving' ? (
                <span class="text-stone-500">Saving…</span>
              ) : status === 'saved' ? (
                <span class="text-emerald-600">Saved ✓</span>
              ) : status === 'error' ? (
                <span class="text-rose-600">Save failed</span>
              ) : status === 'dirty' ? (
                <span class="text-stone-400">Unsaved…</span>
              ) : null}
            </span>
          </div>
        }
      />
      {design ? (
        <EmailDesigner
          design={design}
          documentKey={`component:${id}`}
          onChange={(d) => {
            live.current = d;
            schedule();
          }}
        />
      ) : null}
    </section>
  );
}
