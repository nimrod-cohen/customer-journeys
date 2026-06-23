// App-level store for the email-designer DRAWER. Editing an email from a
// broadcast/campaign opens the full designer in a near-full-width sliding panel
// OVER the current screen (the screen stays mounted, so closing returns instantly
// with no route change / reload). This is the drawer equivalent of the older
// `editorReturn` + navigate('/editor') round-trip — but instead of navigating,
// the opener hands an `onClose(savedTemplateId)` callback that wires the saved
// copy back into the broadcast/campaign. The standalone template-library editor
// still uses the /editor route (unchanged).
import { signal } from '@preact/signals';

export interface DesignerRequest {
  /** An existing template/copy id to edit. Omit (with createAs) to design a new copy. */
  readonly id?: string | undefined;
  /** Create a NEW working copy on first save (a broadcast/campaign's own instance). */
  readonly createAs?: 'copy' | undefined;
  /** Drawer header title (e.g. "Design email"). */
  readonly title?: string | undefined;
  /** Called when the editor closes; `savedId` is the persisted template id (or null). */
  readonly onClose: (savedId: string | null) => void | Promise<void>;
}

/** The active designer request, or null when the drawer is closed. */
export const designerRequest = signal<DesignerRequest | null>(null);

/** Open the email-designer drawer with the given request. */
export function openEmailDesigner(req: DesignerRequest): void {
  designerRequest.value = req;
}

/** Close the drawer (does NOT fire onClose — the editor invokes that itself). */
export function closeEmailDesigner(): void {
  designerRequest.value = null;
}
