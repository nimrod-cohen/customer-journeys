// TemplateEditor — the template HOST for the embeddable EmailDesigner (§11).
// Owns load/save: GET /templates/:id → design (the editable source of truth),
// serializes design → MJML on save (the "editor emits MJML, never hand-rolled
// HTML" invariant) and PUTs/POSTs {name, design, mjml}; the server compiles the
// HTML. Carries over the established editor UX: save STAYS here (Saved ✓), a new
// template moves to /editor/:id, the broadcast "Design email" round-trip returns
// via editorReturn, and a beforeunload guard warns on unsaved changes.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { takeEditorReturn, setReturnedTemplate, setJustSavedTemplate, takeJustSavedTemplate } from '../store/editorReturn.js';
import { Button, Field, Input, PageHeader } from '../ui/kit.js';
import { EmailDesigner } from '../email-designer/EmailDesigner.tsx';
import { designToMjml } from '../email-designer/mjml-serializer.js';
import { emptyDesign, isEmailDesign, type EmailDesign } from '../email-designer/model.js';

interface TemplateRow {
  readonly name: string;
  readonly mjml: string;
  readonly design: unknown;
  readonly kind: string;
}

export function TemplateEditor({ id }: { id?: string }): JSX.Element {
  const editing = Boolean(id);
  const [name, setName] = useState('Untitled');
  const [design, setDesign] = useState<EmailDesign | null>(null);
  const [loadedKey, setLoadedKey] = useState(id ? '' : 'new'); // designer mounts when set
  const [legacy, setLegacy] = useState(false); // stored template has no design (old editor)
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState('');
  // The live design (updated on every committed designer change) + dirty flag.
  const liveDesign = useRef<EmailDesign>(emptyDesign());
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);

  // Load an existing template; a design-less (old-editor) template opens empty
  // with a replace-on-save notice, inheriting RTL from its stored MJML marker.
  useEffect(() => {
    if (!id) {
      liveDesign.current = emptyDesign();
      return;
    }
    void api
      .get<{ template: TemplateRow }>(`/templates/${id}`)
      .then((r) => {
        setName(r.template.name);
        if (isEmailDesign(r.template.design)) {
          setDesign(r.template.design);
          liveDesign.current = r.template.design;
        } else {
          setLegacy(true);
          const rtl = (r.template.mjml ?? '').includes('cdp-rtl');
          const d: EmailDesign = { version: 1, settings: rtl ? { direction: 'rtl' } : {}, rows: [] };
          setDesign(d);
          liveDesign.current = d;
        }
        setLoadedKey(id);
        if (takeJustSavedTemplate(id)) setJustSaved(true);
      })
      .catch(() => navigate('/templates'));
  }, [id]);

  // Warn before a browser refresh/close when there are unsaved changes.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const [mjml, setMjml] = useState('');
  const onDesignChange = (d: EmailDesign): void => {
    liveDesign.current = d;
    setMjml(designToMjml(d));
    dirtyRef.current = true;
    setDirty(true);
    setJustSaved(false);
  };
  // Show the loaded design's MJML before the first edit.
  useEffect(() => {
    setMjml(designToMjml(liveDesign.current));
  }, [loadedKey]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      // Consume the return context up front: a NEW template created from a
      // broadcast/campaign design flow saves as a working COPY (not library).
      const ret = takeEditorReturn();
      const d = liveDesign.current;
      const body: Record<string, unknown> = { name: name || 'Untitled', design: d, mjml: designToMjml(d) };
      if (!id && ret?.createAs === 'copy') body.kind = 'copy';
      let savedId = id;
      if (id) {
        await api.put(`/templates/${id}`, { body });
      } else {
        const r = await api.post<{ template: { id: string } }>('/templates', { body });
        savedId = r.template.id;
      }
      dirtyRef.current = false;
      setDirty(false);
      setJustSaved(true);
      setLegacy(false);
      // Opened from a broadcast flow → hand the template back + return there.
      if (ret) {
        setReturnedTemplate(savedId ?? null);
        navigate(ret.returnPath);
        return;
      }
      // Otherwise STAY; a brand-new template moves to its /editor/:id URL (the
      // remount picks the Saved ✓ flag back up).
      if (!id && savedId) {
        setJustSavedTemplate(savedId);
        navigate(`/editor/${savedId}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="email-editor">
      <button data-testid="editor-back" class="btn-ghost mb-4 btn-sm" onClick={() => navigate('/templates')}>
        ← Back to templates
      </button>
      <PageHeader
        title={editing ? 'Edit email template' : 'New email template'}
        subtitle="Design the email — it compiles to cross-client HTML via MJML on save."
        actions={
          <div class="flex items-end gap-2">
            <Field label="Template name">
              <Input
                data-testid="template-name"
                value={name}
                onInput={(e: Event) => {
                  setName((e.target as HTMLInputElement).value);
                  dirtyRef.current = true;
                  setDirty(true);
                }}
              />
            </Field>
            <Button data-testid="save-template" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Save template'}
            </Button>
            {justSaved && !dirty ? (
              <span data-testid="template-saved" class="self-center text-sm font-medium text-emerald-600">
                Saved ✓
              </span>
            ) : null}
          </div>
        }
      />

      {legacy ? (
        <p data-testid="legacy-template-note" class="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
          This template was created with the previous editor and has no editable design — designing here
          replaces its content when you save.
        </p>
      ) : null}
      {error ? <p class="mb-3 text-sm text-rose-600">{error}</p> : null}

      {loadedKey ? <EmailDesigner design={design} onChange={onDesignChange} documentKey={loadedKey} /> : null}

      <div class="mt-5">
        <span class="label">Emitted MJML</span>
        <textarea data-testid="mjml-output" readOnly value={mjml} rows={6} class="textarea w-full font-mono text-xs" />
      </div>
    </section>
  );
}
