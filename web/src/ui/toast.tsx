// Shared floating toasts — transient, viewport-anchored feedback that is ALWAYS
// in view regardless of how far the user has scrolled (unlike in-flow banners,
// which can render below the fold on a long list). Imperative API:
//   showToast('Broadcast queued')                       → success (default)
//   showToast('Could not send…', { tone: 'error' })     → error, stays longer
//   showToast('Text cleared', { action: { label: 'Undo', onClick } }) → one button
// A single <ToastHost/> (mounted once in AppShell) renders the stack, portaled
// to document.body. aria-live announces toasts without stealing focus.
import { useEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
import { createStore, useStore } from '../store/store.js';

export type ToastTone = 'success' | 'error' | 'info';

/** One button on a toast (e.g. Undo). Running it also closes the toast. */
export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
  readonly ttl: number;
  readonly action?: ToastAction;
}

const toastStore = createStore<readonly Toast[]>([]);
// Monotonic id — Date.now()/Math.random() are avoided project-wide; a counter is
// deterministic and enough to key/dismiss toasts.
let nextId = 1;

/** Show a floating toast. Returns its id (so it can be dismissed early). */
export function showToast(
  message: string,
  opts: { tone?: ToastTone; ttl?: number; action?: ToastAction } = {},
): number {
  const tone = opts.tone ?? 'success';
  // Errors linger (they need reading + may carry a recovery hint); successes are brief.
  // A toast with an action lingers too — it needs time to be clicked.
  const ttl = opts.ttl ?? (tone === 'error' || opts.action ? 6000 : 3500);
  const id = nextId++;
  toastStore.set([...toastStore.get(), { id, message, tone, ttl, ...(opts.action ? { action: opts.action } : {}) }]);
  return id;
}

export function dismissToast(id: number): void {
  toastStore.set(toastStore.get().filter((t) => t.id !== id));
}

/** Run a toast's action once and close it (a second click finds nothing). */
export function runToastAction(id: number): void {
  const t = toastStore.get().find((x) => x.id === id);
  dismissToast(id);
  t?.action?.onClick();
}

/** The toasts on screen now (tests and diagnostics). */
export function currentToasts(): readonly Toast[] {
  return toastStore.get();
}

const TONE: Record<ToastTone, { box: string; icon: JSX.Element }> = {
  success: {
    box: 'border-emerald-200 bg-surface text-ink-900',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" class="h-5 w-5 shrink-0 text-emerald-600" stroke="currentColor" stroke-width="2">
        <circle cx="10" cy="10" r="8" />
        <path d="m6.5 10 2.5 2.5 4.5-5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    ),
  },
  error: {
    box: 'border-rose-200 bg-surface text-ink-900',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" class="h-5 w-5 shrink-0 text-rose-600" stroke="currentColor" stroke-width="2">
        <circle cx="10" cy="10" r="8" />
        <path d="M10 6v4.5M10 13.5h.01" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    ),
  },
  info: {
    box: 'border-stone-200 bg-surface text-ink-900',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" class="h-5 w-5 shrink-0 text-stone-500" stroke="currentColor" stroke-width="2">
        <circle cx="10" cy="10" r="8" />
        <path d="M10 9.5V14M10 6.5h.01" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    ),
  },
};

function ToastRow({ toast }: { toast: Toast }): JSX.Element {
  useEffect(() => {
    const h = globalThis.setTimeout(() => dismissToast(toast.id), toast.ttl);
    return () => globalThis.clearTimeout(h);
  }, [toast.id, toast.ttl]);

  const tone = TONE[toast.tone];
  return (
    <div
      data-testid="toast"
      data-tone={toast.tone}
      class={`pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-card ${tone.box}`}
    >
      {tone.icon}
      <span class="min-w-0 flex-1 break-words">{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          data-testid="toast-action"
          class="shrink-0 rounded px-1.5 font-semibold text-brand-700 hover:bg-stone-100"
          onClick={() => runToastAction(toast.id)}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        data-testid="toast-dismiss"
        aria-label="Dismiss"
        class="-mr-1 shrink-0 rounded p-0.5 text-stone-400 hover:bg-stone-100 hover:text-stone-600"
        onClick={() => dismissToast(toast.id)}
      >
        <svg viewBox="0 0 20 20" fill="none" class="h-4 w-4" stroke="currentColor" stroke-width="2">
          <path d="m5 5 10 10M15 5 5 15" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  );
}

/** Mount ONCE (AppShell). Renders the toast stack fixed to the viewport corner. */
export function ToastHost(): JSX.Element | null {
  const toasts = useStore(toastStore);
  if (!toasts.length) return null;
  return createPortal(
    <div class="pointer-events-none fixed inset-x-0 bottom-4 z-[210] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4">
      <div aria-live="polite" class="flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <ToastRow key={t.id} toast={t} />
        ))}
      </div>
    </div>,
    document.body,
  );
}
