// Create-first-workspace screen (§12). Shown to a logged-in company owner who has
// registered but has no workspace yet (session.needsWorkspace) — registration
// creates the company only; a company and a workspace are distinct, and the owner
// creates their first workspace here. On success the token is re-minted with the
// new active workspace and the app enters the main shell.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useStore } from '../store/store.js';
import { sessionStore, bootstrapWorkspace, logout } from '../store/session.js';
import { Button, Input } from '../ui/kit.js';

export function CreateFirstWorkspace(): JSX.Element {
  const session = useStore(sessionStore);
  // Sensible default: the company name. The owner can rename it (e.g. "Acme – EU").
  const [name, setName] = useState(session.companyName ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError('');
    setBusy(true);
    try {
      await bootstrapWorkspace(trimmed);
    } catch (err) {
      setError((err as { error?: string })?.error ?? 'could not create workspace');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex min-h-screen items-center justify-center bg-stone-50 px-6 py-12">
      <div class="w-full max-w-md animate-fade-up" data-testid="create-first-workspace">
        <div class="mb-6 flex items-center gap-3">
          <span class="grid h-10 w-10 place-items-center rounded-xl bg-brand-500 text-ink-950 shadow-glow">
            <svg viewBox="0 0 24 24" fill="none" class="h-6 w-6" stroke="currentColor" stroke-width="2">
              <path d="M3 12c4-7 14-7 18 0-4 7-14 7-18 0Z" stroke-linejoin="round" />
              <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <span class="font-display text-lg font-bold text-ink-950">Customer Journeys</span>
        </div>

        <div class="rounded-2xl bg-white p-8 shadow-card ring-1 ring-stone-200">
          <h2 class="font-display text-2xl font-bold text-ink-950">Create your first workspace</h2>
          <p class="mt-1 text-sm text-stone-500">
            {session.companyName ? (
              <>
                <span class="font-medium text-ink-900">{session.companyName}</span> is set up. A company can
                hold several workspaces — create your first one to start.
              </>
            ) : (
              'Your company is set up. Create your first workspace to start.'
            )}
          </p>

          <form onSubmit={onSubmit} class="mt-6 space-y-4">
            <div>
              <label class="label" for="first-workspace-name">
                Workspace name
              </label>
              <Input
                id="first-workspace-name"
                data-testid="first-workspace-name"
                value={name}
                onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
                placeholder="e.g. Acme – Main"
              />
              <p class="mt-1.5 text-xs text-stone-400">
                You can add more workspaces later in Company settings.
              </p>
            </div>
            <Button
              data-testid="create-first-workspace-submit"
              type="submit"
              class="w-full"
              loading={busy}
              disabled={busy || !name.trim()}
            >
              {busy ? 'Creating…' : 'Create workspace'}
            </Button>
          </form>

          {error ? (
            <p
              data-testid="first-workspace-error"
              class="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200"
            >
              {error}
            </p>
          ) : null}
        </div>

        <p class="mt-4 text-center text-sm text-stone-500">
          Signed in as {session.email ?? 'you'} ·{' '}
          <button
            type="button"
            data-testid="first-workspace-signout"
            class="font-semibold text-brand-700 hover:underline"
            onClick={() => logout()}
          >
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
