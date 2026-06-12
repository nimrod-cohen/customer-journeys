// A tiny module-level store for the "design an email, then come back" round-trip.
// When a flow (e.g. the broadcast wizard) sends the user to the email editor, it
// records where to RETURN. The editor, on save, hands the saved template id back
// here and navigates to the return path; the originating screen reads the id on
// mount. Module-level so it survives the navigation remount (the SPA keys screens
// by route, so component state is lost across navigation).

interface EditorReturn {
  /** The route to navigate back to after saving the template. */
  readonly returnPath: string;
  /**
   * How a NEW template created in this flow should be saved: 'copy' = a working
   * copy owned by the originating broadcast/campaign (not a library entry).
   */
  readonly createAs?: 'copy';
}

let pending: EditorReturn | null = null;
let returnedTemplateId: string | null = null;

/** Record where the editor should return after saving (set before navigating to /editor). */
export function setEditorReturn(returnPath: string, opts?: { createAs?: 'copy' }): void {
  pending = opts?.createAs ? { returnPath, createAs: opts.createAs } : { returnPath };
}

/** Peek the pending return context WITHOUT consuming it (autosave reads createAs). */
export function peekEditorReturn(): EditorReturn | null {
  return pending;
}

/** Consume the pending return context (null if the editor was opened standalone). */
export function takeEditorReturn(): EditorReturn | null {
  const r = pending;
  pending = null;
  return r;
}

/** The editor records the template it just saved so the originating screen can select it. */
export function setReturnedTemplate(id: string | null): void {
  returnedTemplateId = id;
}

/** Consume the just-saved template id handed back by the editor (null if none). */
export function takeReturnedTemplate(): string | null {
  const id = returnedTemplateId;
  returnedTemplateId = null;
  return id;
}

// ── Saved-flag across the new-template remount ───────────────────────────────
// Saving a NEW template navigates /editor → /editor/:id, which remounts the
// screen (the app body is keyed by route). The freshly-mounted editor reads this
// to keep showing the "Saved ✓" indicator.
let justSavedTemplateId: string | null = null;

export function setJustSavedTemplate(id: string): void {
  justSavedTemplateId = id;
}

export function takeJustSavedTemplate(id: string): boolean {
  const hit = justSavedTemplateId === id;
  if (hit) justSavedTemplateId = null;
  return hit;
}
