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
   * copy owned by the originating broadcast/automation (not a library entry).
   */
  readonly createAs?: 'copy';
}

// The return context is PERSISTED in sessionStorage so it survives a page reload
// inside the editor: a refresh used to wipe this module's memory, and the editor's
// Back button then fell back to the template library instead of the originating
// broadcast/automation. sessionStorage is per-tab and cleared when the tab closes —
// the right lifetime for "where did I come from in this tab".
const STORAGE_KEY = 'cdp.editorReturn';

function loadPending(): EditorReturn | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as EditorReturn) : null;
  } catch {
    return null;
  }
}

function storePending(v: EditorReturn | null): void {
  try {
    if (v) globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(v));
    else globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode / tests) — in-memory only */
  }
}

let pending: EditorReturn | null = loadPending();
let returnedTemplateId: string | null = null;

/** Record where the editor should return after saving (set before navigating to /editor). */
export function setEditorReturn(returnPath: string, opts?: { createAs?: 'copy' }): void {
  pending = opts?.createAs ? { returnPath, createAs: opts.createAs } : { returnPath };
  storePending(pending);
}

/**
 * Clear any return context. Standalone editor opens (the template library, the
 * "Design email" shortcuts) MUST call this so a return left over from an
 * abandoned broadcast/automation flow can't mislabel the Back button or send the
 * user to the wrong place.
 */
export function clearEditorReturn(): void {
  pending = null;
  storePending(null);
}

/** Peek the pending return context WITHOUT consuming it (autosave reads createAs). */
export function peekEditorReturn(): EditorReturn | null {
  return pending;
}

/** Consume the pending return context (null if the editor was opened standalone). */
export function takeEditorReturn(): EditorReturn | null {
  const r = pending;
  pending = null;
  storePending(null);
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

// ── Returned-to marker ───────────────────────────────────────────────────────
// The originating screen (e.g. the broadcast wizard) uses this to restore the
// right step when the editor comes back — even when NO template was saved (the
// returnedTemplateId is null then), so we can't rely on that alone. In-memory:
// it only needs to survive the single navigation back, not a refresh.
let returnedToPath: string | null = null;

/** The editor records WHERE it returned, so that screen can restore its context. */
export function markReturnedTo(path: string): void {
  returnedToPath = path;
}

/** Consume the path the editor just returned to (null if not an editor return). */
export function takeReturnedTo(): string | null {
  const p = returnedToPath;
  returnedToPath = null;
  return p;
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
