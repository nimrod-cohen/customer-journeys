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

/** The asset URL the e2e "insert image" action references (a CloudFront URL). */
const SAMPLE_ASSET_URL = 'https://images.cdp.example/ws/sample-hero.png';

export function EmailEditor({ id }: { id?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [mjml, setMjml] = useState('');
  const [name, setName] = useState('Untitled');
  const [loadedMjml, setLoadedMjml] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = Boolean(id);

  // Edit mode: load the template's name + MJML before applying it to the editor.
  useEffect(() => {
    if (!id) return;
    void api
      .get<{ template: { name: string; mjml: string } }>(`/templates/${id}`)
      .then((r) => {
        setName(r.template.name);
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
    // grapesjs-mjml makes getHtml() return the MJML document.
    setMjml(editor.getHtml());
    return () => editor.destroy();
  }, []);

  // When an existing template's MJML arrives, load it into the editor.
  useEffect(() => {
    if (loadedMjml == null || !editorRef.current) return;
    editorRef.current.setComponents(loadedMjml);
    setMjml(editorRef.current.getHtml());
  }, [loadedMjml]);

  /** Read the current MJML out of the editor (always rooted at <mjml>). */
  const refreshMjml = () => {
    const editor = editorRef.current;
    if (!editor) return;
    setMjml(editor.getHtml());
  };

  /** Insert an <mj-image src> referencing the uploaded asset URL (§11). */
  const insertImage = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const wrapper = editor.getWrapper();
    const column = wrapper?.find('mj-column')[0] ?? wrapper;
    column?.append(`<mj-image src="${SAMPLE_ASSET_URL}" />`);
    refreshMjml();
  };

  // The save payload ({name, mjml}) — the live editor MJML is authoritative;
  // the server compiles + persists it. Never includes hand-rolled HTML.
  const payload: SaveTemplatePayload = { name, mjml };

  const save = async () => {
    setSaving(true);
    try {
      const body = { name: name || 'Untitled', mjml };
      let savedId = id;
      if (id) {
        await api.put(`/templates/${id}`, { body });
      } else {
        const r = await api.post<{ template: { id: string } }>('/templates', { body });
        savedId = r.template.id;
      }
      // If we were opened from a broadcast (or other) flow, hand the saved
      // template back and return there; otherwise go to the Templates list.
      const ret = takeEditorReturn();
      if (ret) {
        setReturnedTemplate(savedId ?? null);
        navigate(ret.returnPath);
      } else {
        navigate('/templates');
      }
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
            <Button data-testid="insert-image" variant="secondary" onClick={insertImage}>
              Insert image
            </Button>
            <Button data-testid="refresh-mjml" variant="secondary" onClick={refreshMjml}>
              Refresh MJML
            </Button>
            <Button data-testid="save-template" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Save template'}
            </Button>
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
            value={mjml}
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
