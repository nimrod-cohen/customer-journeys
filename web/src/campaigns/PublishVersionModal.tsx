// The Save-version modal (styled, NOT a native dialog) — SHARED by the campaign
// detail Builder ("Save & publish") AND the campaigns LIST row "Publish…" action.
// It collects a required version name + a forward/backfill scope (backfill offered
// only when `canBackfill`), surfaces a publish-gate `reason` inline (incomplete
// send node / invalid def / no verified domain), and RETURNS the publish promise so
// the kit Button auto-locks while in flight. testids: publish-modal / version-name /
// publish-scope / publish-confirm — preserved verbatim from the original inline copy.
import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Button, Field, Input } from '../ui/kit.js';
import type { PublishScope } from './versioning.js';

export function PublishVersionModal({
  defaultName,
  canBackfill,
  reason,
  onPublish,
  onClose,
}: {
  defaultName: string;
  canBackfill: boolean;
  reason: string;
  onPublish: (name: string, scope: PublishScope) => Promise<void>;
  onClose: () => void;
}): ReturnType<typeof createPortal> {
  const [versionName, setVersionName] = useState(defaultName);
  // Backfill is only offered for a segment_entry trigger with a segment; otherwise
  // forward-only. Default forward.
  const [scope, setScope] = useState<PublishScope>('forward');

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const trimmed = versionName.trim();
  const confirm = (): Promise<void> => onPublish(trimmed, canBackfill ? scope : 'forward');

  return createPortal(
    <div class="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-6" onClick={onClose}>
      <div
        data-testid="publish-modal"
        class="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 class="text-base font-bold text-ink-950">Save &amp; publish a version</h3>
        <p class="mt-1 text-sm text-stone-500">
          Name this version, then publish it. The live campaign updates immediately.
        </p>

        <Field label="Version name" class="mt-4">
          <Input
            data-testid="version-name"
            placeholder="e.g. Spring refresh"
            value={versionName}
            onInput={(e: Event) => setVersionName((e.target as HTMLInputElement).value)}
          />
        </Field>

        <div class="mt-4" data-testid="publish-scope">
          <span class="label">Who to enroll</span>
          {canBackfill ? (
            <div class="mt-1 space-y-2">
              <label class="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="publish-scope"
                  data-testid="publish-scope-forward"
                  checked={scope === 'forward'}
                  onChange={() => setScope('forward')}
                  class="mt-0.5"
                />
                <span>
                  <span class="font-medium text-ink-900">New entrants only</span>
                  <span class="block text-xs text-stone-500">Enroll people as they enter the segment from now on.</span>
                </span>
              </label>
              <label class="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="publish-scope"
                  data-testid="publish-scope-backfill"
                  checked={scope === 'backfill'}
                  onChange={() => setScope('backfill')}
                  class="mt-0.5"
                />
                <span>
                  <span class="font-medium text-ink-900">Backfill existing members</span>
                  <span class="block text-xs text-stone-500">Also enroll everyone currently in the segment.</span>
                </span>
              </label>
            </div>
          ) : (
            <p data-testid="publish-scope-hint" class="mt-1 text-xs text-stone-500">
              New entrants only. Backfill is available when the trigger is a segment with a segment selected.
            </p>
          )}
        </div>

        {reason ? (
          <p
            data-testid="publish-modal-reason"
            class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200"
          >
            {reason}
          </p>
        ) : null}

        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="publish-cancel"
            class="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-50"
            onClick={onClose}
          >
            Cancel
          </button>
          <Button data-testid="publish-confirm" disabled={!trimmed} onClick={confirm}>
            Publish
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
