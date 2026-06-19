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
  markReturnedTo,
} from '../store/editorReturn.js';
import { Card, Field, Input, PageHeader, Select } from '../ui/kit.js';
import { EmailDesigner } from '../email-designer/EmailDesigner.tsx';
import { designToMjml } from '../email-designer/mjml-serializer.js';
import { emptyDesign, isEmailDesign, type EmailDesign } from '../email-designer/model.js';

interface TemplateRow {
  readonly name: string;
  readonly mjml: string;
  readonly design: unknown;
  readonly kind: string;
  readonly subject: string | null;
  readonly sender_id: string | null;
  readonly to_address: string | null;
  readonly from_selected: boolean;
}
interface Sender {
  id: string;
  name: string;
  email: string;
}

const DEFAULT_TO = '{{customer.email}}';

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
  // Envelope (From / To / Subject) — lives on this email instance, autosaved.
  const [subject, setSubject] = useState('');
  // The From CHOICE: '' = not yet chosen (mandatory), 'no-reply' = the default
  // no-reply@<domain>, or a domain_senders id. sender_id sent to the API is the id
  // for a named sender, else null; from_selected is true once a choice is made.
  const [senderChoice, setSenderChoice] = useState('');
  const [toAddress, setToAddress] = useState(DEFAULT_TO);
  const [senders, setSenders] = useState<Sender[]>([]);
  // Live values in refs so the debounced persist always reads current state.
  const liveDesign = useRef<EmailDesign>(emptyDesign());
  const nameRef = useRef('Untitled');
  const subjectRef = useRef('');
  const senderIdRef = useRef('');
  const fromSelectedRef = useRef(false);
  const toAddressRef = useRef(DEFAULT_TO);
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
        setSubject(r.template.subject ?? '');
        subjectRef.current = r.template.subject ?? '';
        // The From is a named sender (no no-reply): the choice is the sender id.
        const sid = r.template.sender_id ?? '';
        setSenderChoice(sid);
        senderIdRef.current = sid;
        fromSelectedRef.current = sid !== '';
        setToAddress(r.template.to_address ?? DEFAULT_TO);
        toAddressRef.current = r.template.to_address ?? DEFAULT_TO;
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

  // The From dropdown — verified-domain senders (optional; never blocks editing).
  useEffect(() => {
    void api
      .get<{ senders: Sender[] }>('/domain-senders')
      .then((r) => setSenders(r.senders))
      .catch(() => undefined);
  }, []);

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
        subject: subjectRef.current,
        sender_id: senderIdRef.current || null,
        from_selected: fromSelectedRef.current,
        to_address: toAddressRef.current || DEFAULT_TO,
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

  const returnTarget = peekEditorReturn()?.returnPath ?? '';
  const returnPending = returnTarget !== '';
  // "Instance" = a broadcast/campaign's own copy of an email (reached via the
  // "Design email" return flow, or a row whose kind is 'copy'). It is NOT a
  // library template — it reads as an email, and its Back goes to that
  // broadcast/campaign, not the template library.
  const instance = returnPending || kind === 'copy';
  const backLabel = returnTarget.startsWith('/campaigns')
    ? 'Back to campaign'
    : returnTarget.startsWith('/broadcasts')
      ? 'Back to broadcast'
      : instance
        ? 'Back'
        : 'Back to templates';

  /** Leave the editor. Everything autosaves, but a change made within the
   *  debounce window isn't persisted yet — so flush any pending change first
   *  (staying put if that save fails), then navigate back: to the originating
   *  broadcast/campaign when opened from there, else to the template library. */
  const goBack = async (): Promise<void> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (dirtyRef.current || savingRef.current || queuedRef.current) {
      const okSave = await persist();
      if (!okSave) return;
    }
    const ret = takeEditorReturn();
    if (ret) {
      setReturnedTemplate(idRef.current ?? null);
      markReturnedTo(ret.returnPath); // so the originating screen restores its step
      navigate(ret.returnPath);
    } else {
      navigate('/templates');
    }
  };

  return (
    <section data-testid="email-editor">
      <button
        data-testid="editor-back"
        class="btn-ghost mb-4 btn-sm disabled:cursor-default disabled:opacity-50"
        onClick={() => void goBack()}
        disabled={status === 'saving'}
      >
        ← {backLabel}
      </button>
      <PageHeader
        title={instance ? 'Edit email' : editing ? 'Edit email template' : 'New email template'}
        subtitle={
          instance
            ? "This is this broadcast's own copy of the email — changes here don't affect the template library."
            : 'Design the email — changes save automatically and compile to cross-client HTML via MJML.'
        }
        actions={
          <div class="flex items-end gap-3">
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
            {/* No manual save — every change autosaves; this just reflects status. */}
            <span data-testid="save-status" class="min-w-[5rem] pb-2 text-sm font-medium">
              {status === 'saving' ? (
                <span class="text-stone-500">Saving…</span>
              ) : status === 'saved' ? (
                <span data-testid="template-saved" class="text-emerald-600">Saved ✓</span>
              ) : status === 'error' ? (
                <span class="text-rose-600">Save failed</span>
              ) : status === 'dirty' ? (
                <span class="text-stone-400">Unsaved…</span>
              ) : null}
            </span>
          </div>
        }
      />

      {/* From / To / Subject belong to an actual EMAIL — a broadcast/campaign's own
          copy. A library template is just a reusable DESIGN, so it has no envelope;
          the envelope is filled in on the copy made when it's attached to a send. */}
      {instance ? (
        <Card class="mb-4 grid gap-3 p-4 sm:grid-cols-2">
          <Field label="From">
            <Select
              data-testid="email-sender"
              value={senderChoice}
              onChange={(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                setSenderChoice(v);
                // The From MUST be a real named sender — no no-reply fallback.
                senderIdRef.current = v;
                fromSelectedRef.current = v !== '';
                scheduleAutosave();
              }}
            >
              <option value="" disabled>
                Choose a sender…
              </option>
              {senders.map((sn) => (
                <option key={sn.id} value={sn.id}>
                  {sn.name} &lt;{sn.email}&gt;
                </option>
              ))}
            </Select>
            {senders.length === 0 ? (
              <p class="mt-1 text-xs text-amber-700">
                No senders yet — add one for a verified domain in Workspace settings → Sending domains.
              </p>
            ) : null}
          </Field>
          <Field label="To">
            <Input
              data-testid="email-to"
              value={toAddress}
              placeholder={DEFAULT_TO}
              onInput={(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                setToAddress(v);
                toAddressRef.current = v;
                scheduleAutosave();
              }}
            />
          </Field>
          <Field label="Subject" class="sm:col-span-2">
            <Input
              data-testid="email-subject"
              value={subject}
              placeholder="Your spring update is here"
              onInput={(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                setSubject(v);
                subjectRef.current = v;
                scheduleAutosave();
              }}
            />
          </Field>
        </Card>
      ) : null}

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
