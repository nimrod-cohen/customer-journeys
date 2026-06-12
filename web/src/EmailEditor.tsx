// EmailEditor — a Preact component embedding CORE GrapesJS (BSD-3) + the
// grapesjs-mjml plugin (NOT the paid Studio SDK), §11. The editor EMITS MJML:
// grapesjs-mjml registers MJML-backed blocks and `editor.getHtml()` returns the
// MJML document (its export type is `mjml`). We surface that MJML to the page so
// the save path (server compileMjml) and the browser e2e can read it.
//
// It is a real TEMPLATE editor: with no id it creates a template, with an id it
// loads + updates one. Reached from the Templates list and from the "Design
// email" action on Broadcasts/Campaigns. When opened from a broadcast it returns
// to that broadcast on save (see editorReturn).
import { useEffect, useRef, useState } from 'preact/hooks';
import grapesjs, { type Editor } from 'grapesjs';
import grapesjsMjml from 'grapesjs-mjml';
import 'grapesjs/dist/css/grapes.min.css';
import { serializeEditorToMjml, type SaveTemplatePayload } from './serialize.js';
import { Button, Card, Field, Input, PageHeader } from './ui/kit.js';
import { api } from './store/session.js';
import { navigate } from './router.js';
import { takeEditorReturn, setReturnedTemplate } from './store/editorReturn.js';

/** A starter MJML doc so the editor renders something deterministic on load. */
const INITIAL_MJML = serializeEditorToMjml({
  blocks: [{ type: 'text', content: 'Welcome to the CDP editor' }],
});

/**
 * A minimal EDITABLE skeleton: an <mj-body> with an empty section+column. Used
 * when a stored template has no <mj-body> (e.g. an empty `<mjml></mjml>`), which
 * would otherwise leave the canvas with no valid drop target so dragged blocks go
 * nowhere. With a body present, GrapesJS accepts dropped sections/columns/blocks.
 */
const EDITABLE_SKELETON = '<mjml><mj-body><mj-section><mj-column></mj-column></mj-section></mj-body></mjml>';

/** Ensure the MJML has a body the editor can drop into; else an editable skeleton. */
function ensureBody(mjml: string | null | undefined): string {
  return mjml && mjml.includes('<mj-body') ? mjml : EDITABLE_SKELETON;
}

/**
 * RTL (right-to-left) is applied at the DOCUMENT level: a head with an
 * mj-attributes default + a style makes every mj-text render right-to-left
 * (Hebrew/Arabic). `dir="rtl"` on mj-text is invalid under strict MJML, and a
 * css-class needs a defined rule — so the head carries both. The head is managed
 * here as a STRING layer (kept out of the GrapesJS body model) so it round-trips
 * cleanly. The marker class `cdp-rtl` also lets us detect RTL on load.
 */
const RTL_HEAD =
  '<mj-head><mj-attributes><mj-text css-class="cdp-rtl" align="right" /></mj-attributes>' +
  '<mj-style>.cdp-rtl div{direction:rtl;text-align:right}</mj-style></mj-head>';

/** Whether a stored MJML doc is RTL (carries our marker). */
function isRtl(mjml: string | null | undefined): boolean {
  return !!mjml && mjml.includes('cdp-rtl');
}

/** Strip ANY <mj-head> so the editor body model never holds the RTL head. */
function stripHead(mjml: string): string {
  return mjml.replace(/<mj-head>[\s\S]*?<\/mj-head>/i, '');
}

/** Produce the document MJML for save/preview: body + (RTL head when enabled). */
function withRtl(bodyMjml: string, rtl: boolean): string {
  const base = stripHead(bodyMjml);
  return rtl ? base.replace('<mjml>', `<mjml>${RTL_HEAD}`) : base;
}

/** The asset URL the e2e "insert image" action references (a CloudFront URL). */
const SAMPLE_ASSET_URL = 'https://images.cdp.example/ws/sample-hero.png';

export function EmailEditor({ id }: { id?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [mjml, setMjml] = useState('');
  const [name, setName] = useState('Untitled');
  const [loadedMjml, setLoadedMjml] = useState<string | null>(null);
  const [rtl, setRtl] = useState(false);
  const [saving, setSaving] = useState(false);
  // The emitted MJML as of the last load/save — compared against the live emitted
  // MJML to know if there are UNSAVED changes (for the refresh/close warning).
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const editing = Boolean(id);
  // Mirror `rtl`/dirty into refs so once-registered listeners see current values.
  const rtlRef = useRef(false);
  const dirtyRef = useRef(false);

  /**
   * Apply text direction to the editor CANVAS (preview) so RTL renders live —
   * Hebrew/Arabic bidi (e.g. a sentence-ending period) is correct. We set dir on
   * the body AND inject a style into the canvas iframe that forces direction:rtl
   * on every element (a plain body `direction` doesn't reliably reach the text
   * inside MJML's nested tables). Preview-only — the compiled email gets its
   * direction from the RTL head.
   */
  const applyCanvasDir = (on: boolean) => {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      const body = editor.Canvas.getBody() as HTMLElement | undefined;
      if (body) body.setAttribute('dir', on ? 'rtl' : 'ltr');
      const doc = editor.Canvas.getDocument() as Document | undefined;
      if (!doc) return;
      const ID = 'cdp-rtl-style';
      let style = doc.getElementById(ID) as HTMLStyleElement | null;
      if (on) {
        if (!style) {
          style = doc.createElement('style');
          style.id = ID;
          doc.head.appendChild(style);
        }
        style.textContent = 'body, body * { direction: rtl; } body { text-align: right; }';
      } else if (style) {
        style.remove();
      }
    } catch {
      /* canvas frame not ready yet — the canvas:frame:load handler re-applies */
    }
  };

  // Edit mode: load the template's name + MJML before applying it to the editor.
  useEffect(() => {
    if (!id) return;
    void api
      .get<{ template: { name: string; mjml: string } }>(`/templates/${id}`)
      .then((r) => {
        setName(r.template.name);
        setRtl(isRtl(r.template.mjml));
        setLoadedMjml(r.template.mjml ?? '');
      })
      .catch(() => navigate('/templates'));
  }, [id]);

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = grapesjs.init({
      container: hostRef.current,
      height: '500px',
      storageManager: false,
      fromElement: false,
      plugins: [grapesjsMjml],
      pluginsOpts: { [grapesjsMjml as unknown as string]: {} },
    });
    editor.setComponents(INITIAL_MJML);
    editorRef.current = editor;

    // Enrich the rich-text toolbar (shown when a text block is double-clicked).
    // Defaults already include bold/italic/underline/strikethrough/link; we add
    // alignment, lists, and font size. Each runs a contenteditable command, which
    // produces ordinary inline HTML inside mj-text (valid under strict MJML).
    const rte = editor.RichTextEditor;
    const cmd = (name: string, icon: string, title: string, command: string) =>
      rte.add(name, { icon, attributes: { title }, result: (r: { exec: (c: string) => void }) => r.exec(command) });
    cmd('cdp-align-left', '⟸', 'Align left', 'justifyLeft');
    cmd('cdp-align-center', '↔', 'Align center', 'justifyCenter');
    cmd('cdp-align-right', '⟹', 'Align right', 'justifyRight');
    cmd('cdp-ul', '•', 'Bulleted list', 'insertUnorderedList');
    cmd('cdp-ol', '1.', 'Numbered list', 'insertOrderedList');
    rte.add('cdp-font-size', {
      icon: `<select class="gjs-field" title="Font size" style="background:transparent;border:0;color:inherit;font:inherit;cursor:pointer">
          <option value="">Size</option>
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="5">Large</option>
          <option value="7">Huge</option>
        </select>`,
      event: 'change',
      result: (r: { exec: (c: string, v?: string) => void }, action: { btn?: HTMLElement }) => {
        const sel = action.btn?.querySelector('select');
        if (sel && sel.value) r.exec('fontSize', sel.value);
      },
    });

    // grapesjs-mjml makes getHtml() return the MJML document. Keep the surfaced
    // MJML LIVE: GrapesJS emits 'update' on every canvas change, so the preview
    // and the saved payload always reflect the current design (not a stale
    // snapshot from load/refresh).
    const sync = () => setMjml(editor.getHtml());
    sync();
    setSavedSnapshot(withRtl(editor.getHtml(), false)); // initial baseline (clean)
    editor.on('update', sync);
    // Re-assert the canvas direction when the frame (re)loads.
    editor.on('canvas:frame:load', () => applyCanvasDir(rtlRef.current));
    return () => editor.destroy();
  }, []);

  // Warn before a browser refresh/close when there are UNSAVED changes (in-app
  // hash navigation doesn't unload the page, so this only guards real reloads).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Reflect RTL in the CANVAS too (not just the compiled output) so the preview
  // shows true right-to-left — Hebrew/Arabic bidi (e.g. sentence-ending period)
  // renders correctly. The compiled email gets direction from the RTL head.
  useEffect(() => {
    rtlRef.current = rtl;
    applyCanvasDir(rtl);
  }, [rtl]);

  // When an existing template's MJML arrives, load it into the editor. A stored
  // template with no <mj-body> (e.g. an empty doc) is loaded as an editable
  // skeleton so the canvas has a drop target.
  useEffect(() => {
    if (loadedMjml == null || !editorRef.current) return;
    // The RTL head is a string layer; the editor body never holds it.
    editorRef.current.setComponents(ensureBody(stripHead(loadedMjml)));
    setMjml(editorRef.current.getHtml());
    // Baseline for unsaved-change detection: the loaded doc is "clean".
    setSavedSnapshot(withRtl(editorRef.current.getHtml(), isRtl(loadedMjml)));
  }, [loadedMjml]);

  /** Read the current MJML out of the editor (always rooted at <mjml>). */
  const refreshMjml = () => {
    const editor = editorRef.current;
    if (!editor) return;
    setMjml(editor.getHtml());
  };

  /**
   * Insert an <mj-image src> referencing the uploaded asset URL (§11), nested
   * INSIDE the MJML body (never appended to the wrapper, which would place it
   * after </mjml> and produce an invalid two-root document the server rejects).
   * We splice it into the current MJML and re-parse so the tree stays valid.
   */
  const insertImage = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const img = `<mj-image src="${SAMPLE_ASSET_URL}" />`;
    const cur = editor.getHtml();
    let next: string;
    if (cur.includes('</mj-column>')) {
      next = cur.replace('</mj-column>', `${img}</mj-column>`);
    } else if (cur.includes('</mj-body>')) {
      next = cur.replace('</mj-body>', `<mj-section><mj-column>${img}</mj-column></mj-section></mj-body>`);
    } else {
      next = cur;
    }
    editor.setComponents(next);
    refreshMjml();
  };

  // The save payload ({name, mjml}) — the live editor MJML is authoritative;
  // the server compiles + persists it. Never includes hand-rolled HTML. The
  // emitted doc carries the RTL head when the RTL toggle is on.
  const emitted = withRtl(mjml, rtl);
  const payload: SaveTemplatePayload = { name, mjml: emitted };
  // Unsaved changes = the live doc differs from the last load/save baseline.
  const dirty = savedSnapshot !== null && emitted !== savedSnapshot;
  dirtyRef.current = dirty;

  const save = async () => {
    setSaving(true);
    try {
      // Read the CURRENT MJML straight from the editor (authoritative) rather than
      // any state snapshot, so the latest canvas edits are always persisted. Never
      // persist a body-less doc (it would be un-editable on reload). Apply RTL.
      const currentMjml = withRtl(ensureBody(editorRef.current?.getHtml() ?? mjml), rtl);
      const body = { name: name || 'Untitled', mjml: currentMjml };
      setSavedSnapshot(currentMjml); // mark clean — the saved doc is the new baseline
      dirtyRef.current = false;
      let savedId = id;
      if (id) {
        await api.put(`/templates/${id}`, { body });
      } else {
        const r = await api.post<{ template: { id: string } }>('/templates', { body });
        savedId = r.template.id;
      }
      // Opened from a broadcast (or other) flow → hand the template back + return.
      const ret = takeEditorReturn();
      if (ret) {
        setReturnedTemplate(savedId ?? null);
        navigate(ret.returnPath);
        return;
      }
      // Otherwise STAY in the editor (don't bounce to the list). A brand-new
      // template moves to its /editor/:id URL so the save is addressable and a
      // refresh reloads it; editing an existing one just stays put.
      setJustSaved(true);
      if (!id && savedId) navigate(`/editor/${savedId}`);
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
        subtitle="Design with MJML blocks — output compiles to cross-client HTML on save."
        actions={
          <div class="flex items-end gap-2">
            <Field label="Template name">
              <Input
                data-testid="template-name"
                value={name}
                onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
              />
            </Field>
            <label
              data-testid="rtl-toggle-label"
              class="flex h-9 cursor-pointer select-none items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 text-sm font-medium text-ink-800"
              title="Right-to-left text (Hebrew, Arabic…)"
            >
              <input
                data-testid="rtl-toggle"
                type="checkbox"
                checked={rtl}
                onChange={(e: Event) => setRtl((e.target as HTMLInputElement).checked)}
              />
              RTL
            </label>
            <Button data-testid="insert-image" variant="secondary" onClick={insertImage}>
              Insert image
            </Button>
            <Button data-testid="refresh-mjml" variant="secondary" onClick={refreshMjml}>
              Refresh MJML
            </Button>
            <Button data-testid="save-template" onClick={save} disabled={saving}>
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
      <Card class="overflow-hidden">
        <div data-testid="gjs-host" ref={hostRef} />
      </Card>

      <div class="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <span class="label">Emitted MJML</span>
          <textarea
            data-testid="mjml-output"
            readOnly
            value={emitted}
            rows={8}
            class="textarea w-full font-mono text-xs"
          />
        </div>
        <div>
          <span class="label">Save payload</span>
          <pre
            data-testid="payload-preview"
            class="h-full overflow-auto rounded-lg bg-stone-900 p-3 font-mono text-xs text-brand-200"
          >
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      </div>
    </section>
  );
}
