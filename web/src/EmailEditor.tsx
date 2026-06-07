// EmailEditor — a Preact component embedding CORE GrapesJS (BSD-3) + the
// grapesjs-mjml plugin (NOT the paid Studio SDK), §11. The editor EMITS MJML:
// grapesjs-mjml registers MJML-backed blocks and `editor.getHtml()` returns the
// MJML document (its export type is `mjml`). We surface that MJML to the page so
// the save path (server compileMjml) and the browser e2e can read it.
//
// Image insertion adds an `<mj-image src>` referencing an uploaded asset URL —
// proving §11's "images become mj-image" rule end to end in a real browser.
import { useEffect, useRef, useState } from 'preact/hooks';
import grapesjs, { type Editor } from 'grapesjs';
import grapesjsMjml from 'grapesjs-mjml';
import 'grapesjs/dist/css/grapes.min.css';
import { serializeEditorToMjml, type SaveTemplatePayload } from './serialize.js';

/** A starter MJML doc so the editor renders something deterministic on load. */
const INITIAL_MJML = serializeEditorToMjml({
  blocks: [{ type: 'text', content: 'Welcome to the CDP editor' }],
});

/** The asset URL the e2e "insert image" action references (a CloudFront URL). */
const SAMPLE_ASSET_URL = 'https://images.cdp.example/ws/sample-hero.png';

export function EmailEditor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [mjml, setMjml] = useState('');

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
    // Find the first mj-column (created by the MJML preset) to host the image.
    const column = wrapper?.find('mj-column')[0] ?? wrapper;
    column?.append(`<mj-image src="${SAMPLE_ASSET_URL}" />`);
    refreshMjml();
  };

  // The save payload ({name, mjml}) — the live editor MJML is authoritative;
  // the server compiles + persists it. Never includes hand-rolled HTML.
  const payload: SaveTemplatePayload = { name: 'Untitled', mjml };

  return (
    <section>
      <header>
        <h1>Email editor</h1>
        <button data-testid="insert-image" type="button" onClick={insertImage}>
          Insert image
        </button>
        <button data-testid="refresh-mjml" type="button" onClick={refreshMjml}>
          Refresh MJML
        </button>
      </header>
      <div data-testid="gjs-host" ref={hostRef} />
      {/* The live MJML, surfaced for the save path + the browser e2e. */}
      <textarea data-testid="mjml-output" readOnly value={mjml} rows={8} cols={80} />
      <pre data-testid="payload-preview">{JSON.stringify(payload)}</pre>
    </section>
  );
}
