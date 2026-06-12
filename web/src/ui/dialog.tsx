// Shared in-app dialogs — the project rule is NEVER to use native JS modals
// (confirm/alert/prompt); these are the styled replacements. Imperative API:
//   await askText({ title, label?, initial?, placeholder? })  → string | null
//   await askConfirm({ title, message, danger?, confirmLabel? }) → boolean
// A single <DialogHost/> (mounted once in AppShell) renders the active dialog,
// portaled to document.body so transformed ancestors can't hijack the overlay.
import { useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
import { createStore, useStore } from '../store/store.js';

interface TextDialog {
  readonly kind: 'text';
  readonly title: string;
  readonly label?: string;
  readonly initial?: string;
  readonly placeholder?: string;
  readonly confirmLabel?: string;
  readonly resolve: (value: string | null) => void;
}

interface ConfirmDialog {
  readonly kind: 'confirm';
  readonly title: string;
  readonly message: string;
  readonly danger?: boolean;
  readonly confirmLabel?: string;
  readonly resolve: (ok: boolean) => void;
}

type DialogState = TextDialog | ConfirmDialog | null;

const dialogStore = createStore<DialogState>(null);

/** Ask for a line of text (styled prompt). Resolves null on cancel. */
export function askText(opts: Omit<TextDialog, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    dialogStore.set({ kind: 'text', ...opts, resolve });
  });
}

/** Ask for confirmation (styled confirm). Resolves false on cancel/dismiss. */
export function askConfirm(opts: Omit<ConfirmDialog, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    dialogStore.set({ kind: 'confirm', ...opts, resolve });
  });
}

function close(result: string | null | boolean): void {
  const d = dialogStore.get();
  dialogStore.set(null);
  if (!d) return;
  if (d.kind === 'text') d.resolve(typeof result === 'string' ? result : null);
  else d.resolve(result === true);
}

/** Mount ONCE (AppShell). Renders the active dialog above everything (z-200). */
export function DialogHost(): JSX.Element | null {
  const d = useStore(dialogStore);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!d) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(d.kind === 'text' ? null : false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [d]);

  if (!d) return null;

  const confirm = (): void => {
    if (d.kind === 'text') close(inputRef.current?.value.trim() ?? '');
    else close(true);
  };

  return createPortal(
    <div
      class="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-6"
      onClick={() => close(d.kind === 'text' ? null : false)}
    >
      <div
        data-testid="app-dialog"
        class="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 class="text-base font-bold text-ink-950">{d.title}</h3>
        {d.kind === 'confirm' ? (
          <p data-testid="dialog-message" class="mt-2 text-sm text-stone-600">
            {d.message}
          </p>
        ) : (
          <label class="mt-3 block">
            {d.label ? <span class="mb-1 block text-xs font-semibold text-stone-500">{d.label}</span> : null}
            <input
              ref={inputRef}
              data-testid="dialog-input"
              type="text"
              value={d.initial ?? ''}
              placeholder={d.placeholder ?? ''}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm();
              }}
              class="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-ink-900 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30"
            />
          </label>
        )}
        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="dialog-cancel"
            class="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-50"
            onClick={() => close(d.kind === 'text' ? null : false)}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="dialog-confirm"
            class={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${
              d.kind === 'confirm' && d.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-brand-600 hover:bg-brand-700'
            }`}
            onClick={confirm}
          >
            {d.confirmLabel ?? (d.kind === 'confirm' ? 'Confirm' : 'OK')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
