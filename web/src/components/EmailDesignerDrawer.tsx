// The email-designer DRAWER — a near-full-width panel that slides in from the
// right and hosts the full TemplateEditor (embedded mode) OVER the current
// screen. Opened via the `emailDesignerDrawer` store from a broadcast/campaign's
// "Design email" action, so editing an email never navigates away (the screen
// underneath stays mounted; closing returns instantly with no reload).
//
// Close is ONLY via the editor's own "Save & close" (which flushes the autosave
// then fires onClose) — the dim backdrop is intentionally non-closing so a stray
// click can't drop a half-designed email. Mounted once, app-level, in AppShell.
import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
import { designerRequest, closeEmailDesigner } from '../store/emailDesignerDrawer.js';
import { TemplateEditor } from '../screens/TemplateEditor.tsx';

const ANIM_MS = 300;

export function EmailDesignerDrawer(): JSX.Element | null {
  const req = designerRequest.value;
  // Keep the last request around through the slide-out animation.
  const [mounted, setMounted] = useState(Boolean(req));
  const [visible, setVisible] = useState(false);
  const [shown, setShown] = useState(req);

  useEffect(() => {
    if (req) {
      setShown(req);
      setMounted(true);
      const r = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(r);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), ANIM_MS);
    return () => clearTimeout(t);
  }, [req]);

  if (!mounted || !shown) return null;

  const handleClose = (savedId: string | null): void => {
    // Fire the opener's wiring (attach the copy, reload, etc.) THEN close the drawer.
    void Promise.resolve(shown.onClose(savedId)).finally(() => closeEmailDesigner());
  };

  return createPortal(
    <div class="fixed inset-0 z-[60] flex justify-end" data-testid="email-designer-drawer">
      <div
        class={`absolute inset-0 bg-ink-950/40 transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        class={`relative z-10 flex h-full w-full max-w-[96vw] flex-col bg-stone-50 shadow-soft transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header class="flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-5 py-3">
          <h2 class="text-base font-bold text-ink-900">{shown.title ?? 'Design email'}</h2>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <TemplateEditor
            // Remount on a new request (different id/createAs) so the editor resets.
            key={shown.id ?? `new:${shown.createAs ?? ''}`}
            embedded
            id={shown.id}
            createAs={shown.createAs}
            onClose={handleClose}
          />
        </div>
      </aside>
    </div>,
    document.body,
  );
}
