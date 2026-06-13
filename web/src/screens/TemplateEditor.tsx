// TemplateEditor — the template HOST for the embeddable EmailDesigner (§11).
// Owns load/save: GET /templates/:id → design (the editable source of truth),
// serializes design → MJML (the "editor emits MJML, never hand-rolled HTML"
// invariant) and persists {name, design, mjml}; the server compiles the HTML.
//
// Changes AUTOSAVE (debounced ~800ms, nomentor-style) with a Saving…/Saved ✓
// status. The FIRST autosave of a new template creates the row and silently
// rewrites the URL to /editor/:id (history.replaceState — no remount, no lost
// edits; a refresh then reloads the saved template). The broadcast "Design
// email" round-trip is finished EXPLICITLY via the "Save & return" button (an
// autosave never navigates away mid-design).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import {
  takeEditorReturn,
  peekEditorReturn,
  setReturnedTemplate,
} from '../store/editorReturn.js';
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

const AUTOSAVE_MS = 800;

export function TemplateEditor({ id }: { id?: string }): JSX.Element {
  const editing = Boolean(id);
  const [name, setName] = useState('Untitled');
  const [design, setDesign] = useState<EmailDesign | null>(null);
  const [loadedKey, setLoadedKey] = useState(id ? '' : 'new'); // designer mounts when set
  const [legacy, setLegacy] = useState(false); // stored template has no design (old editor)
  const [kind, setKind] = useState(''); // 'library' | 'copy' — a copy is a broadcast/campaign's own email instance
  const [status, setStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  // Live values in refs so the debounced persist always reads current state.
  const liveDesign = useRef<EmailDesign>(emptyDesign());
  const nameRef = useRef('Untitled');
  const idRef = useRef<string | undefined>(id); // becomes set on first auto-create
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mjml, setMjml] = useState('');

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
        nameRef.current = r.template.name;
        setKind(r.template.kind);
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
      })
      .catch(() => navigate('/templates'));
  }, [id]);

  // Warn before a browser refresh/close while changes are not yet persisted
  // (autosave shrinks that window to ~a second).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (dirtyRef.current || savingRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  /** Persist the current design/name. Creates the row on first save (a working
   *  COPY when this editor was opened from a broadcast design flow). */
  const persist = async (): Promise<boolean> => {
    if (savingRef.current) {
      queuedRef.current = true; // run again after the in-flight save
      return true;
    }
    savingRef.current = true;
    dirtyRef.current = false;
    setStatus('saving');
    setError('');
    try {
      const d = liveDesign.current;
      const body: Record<string, unknown> = {
        name: nameRef.current || 'Untitled',
        design: d,
        mjml: designToMjml(d),
      };
      if (idRef.current) {
        await api.put(`/templates/${idRef.current}`, { body });
      } else {
        if (peekEditorReturn()?.createAs === 'copy') body.kind = 'copy';
        const r = await api.post<{ template: { id: string } }>('/templates', { body });
        idRef.current = r.template.id;
        // Silent URL rewrite (no remount — in-progress edits are kept); a
        // refresh now reloads the saved template.
        history.replaceState(null, '', `#/editor/${r.template.id}`);
      }
      setStatus(dirtyRef.current ? 'dirty' : 'saved');
      return true;
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Save failed');
      dirtyRef.current = true;
      return false;
    } finally {
      savingRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void persist();
      }
    }
  };

  const scheduleAutosave = (): void => {
    dirtyRef.current = true;
    setStatus('dirty');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void persist(), AUTOSAVE_MS);
  };

  const onDesignChange = (d: EmailDesign): void => {
    liveDesign.current = d;
    setMjml(designToMjml(d));
    setLegacy(false);
    scheduleAutosave();
  };
  // Show the loaded design's MJML before the first edit.
  useEffect(() => {
    setMjml(designToMjml(liveDesign.current));
  }, [loadedKey]);

  /** Explicit save: flush now; if opened from a broadcast flow, return there. */
  const saveNow = async (): Promise<void> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const okSave = await persist();
    if (!okSave) return;
    const ret = takeEditorReturn();
    if (ret) {
      setReturnedTemplate(idRef.current ?? null);
      navigate(ret.returnPath);
    }
  };

  const returnPending = peekEditorReturn() !== null;
  // "Instance" = a broadcast/campaign's own copy of an email (reached via the
  // "Design email" return flow, or a row whose kind is 'copy'). It is NOT a
  // library template — so it has no "Back to templates" exit and reads as an
  // email, not a template.
  const instance = returnPending || kind === 'copy';

  return (
    <section data-testid="email-editor">
      {instance ? null : (
        <button data-testid="editor-back" class="btn-ghost mb-4 btn-sm" onClick={() => navigate('/templates')}>
          ← Back to templates
        </button>
      )}
      <PageHeader
        title={instance ? 'Edit email' : editing ? 'Edit email template' : 'New email template'}
        subtitle={
          instance
            ? "This is this broadcast's own copy of the email — changes here don't affect the template library."
            : 'Design the email — changes save automatically and compile to cross-client HTML via MJML.'
        }
        actions={
          <div class="flex items-end gap-2">
            <Field label={instance ? 'Email name' : 'Template name'}>
              <Input
                data-testid="template-name"
                value={name}
                onInput={(e: Event) => {
                  const v = (e.target as HTMLInputElement).value;
                  setName(v);
                  nameRef.current = v;
                  scheduleAutosave();
                }}
              />
            </Field>
            {/* Button + save status share one bottom-aligned row, with the
                status vertically centered against the button (not floating up
                toward the field label). */}
            <div class="flex items-center gap-2">
              <Button data-testid="save-template" onClick={() => void saveNow()} disabled={status === 'saving'}>
                {returnPending ? 'Save & return' : 'Save now'}
              </Button>
              <span data-testid="save-status" class="min-w-[4.5rem] text-sm font-medium">
                {status === 'saving' ? (
                  <span class="text-stone-500">Saving…</span>
                ) : status === 'saved' ? (
                  <span data-testid="template-saved" class="text-emerald-600">Saved ✓</span>
                ) : status === 'error' ? (
                  <span class="text-rose-600">Save failed</span>
                ) : status === 'dirty' ? (
                  <span class="text-stone-400">…</span>
                ) : null}
              </span>
            </div>
          </div>
        }
      />

      {legacy ? (
        <p data-testid="legacy-template-note" class="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
          This template was created with the previous editor and has no editable design — designing here
          replaces its content when it saves.
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
