// Pure editor → MJML serialization (§11, CLAUDE.md non-negotiable).
//
// The WYSIWYG editor EMITS MJML — never hand-rolled email HTML. This module owns
// the editor's logical state → MJML string transform and the save payload shape.
// It is framework-free and unit-tested without a browser or GrapesJS so the
// "emits MJML" invariant is provable at the unit tier. Compilation to HTML is a
// SERVER concern (compileMjml at save) — there is intentionally no HTML here.

/** A block in the editor's logical document. Images become `<mj-image>`. */
export type EditorBlock =
  | { readonly type: 'text'; readonly content: string }
  | { readonly type: 'image'; readonly src: string; readonly alt?: string }
  | { readonly type: 'button'; readonly content: string; readonly href?: string };

/** The editor's serializable state (a flat ordered list of blocks). */
export interface EditorState {
  readonly blocks: readonly EditorBlock[];
}

/** Minimal XML-escape for text/attribute values placed into MJML. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a single block to its MJML element. */
function blockToMjml(block: EditorBlock): string {
  switch (block.type) {
    case 'text':
      return `<mj-text>${esc(block.content)}</mj-text>`;
    case 'image': {
      const alt = block.alt ? ` alt="${esc(block.alt)}"` : '';
      // An uploaded asset URL is referenced as `<mj-image src>` (§11).
      return `<mj-image src="${esc(block.src)}"${alt} />`;
    }
    case 'button': {
      const href = block.href ? ` href="${esc(block.href)}"` : '';
      return `<mj-button${href}>${esc(block.content)}</mj-button>`;
    }
  }
}

/**
 * Serialize editor state to a complete MJML document. The root is ALWAYS
 * `<mjml>` (never raw HTML); blocks become `<mj-text>` / `<mj-image>` /
 * `<mj-button>` inside a single section/column. The output is valid input for
 * the server-side compileMjml.
 */
export function serializeEditorToMjml(state: EditorState): string {
  const body = state.blocks.map(blockToMjml).join('');
  return `<mjml><mj-body><mj-section><mj-column>${body}</mj-column></mj-section></mj-body></mjml>`;
}

/** The save payload the client POSTs — `{ name, mjml }` ONLY (no HTML). */
export interface SaveTemplatePayload {
  readonly name: string;
  readonly mjml: string;
}

/**
 * Build the save payload from editor state + a template name. Contains ONLY
 * `{ name, mjml }` — the server compiles + stores the HTML; the client never
 * sends hand-rolled HTML or a workspace id (the latter is from the auth context).
 */
export function buildSaveTemplatePayload(state: EditorState, name: string): SaveTemplatePayload {
  return { name, mjml: serializeEditorToMjml(state) };
}
