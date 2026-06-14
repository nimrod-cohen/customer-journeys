// Account settings (§12): the signed-in user edits their OWN details. The display
// name is app-owned (editable here); email is managed by the login provider and
// the workspace role is set by an owner — both shown read-only. Any authenticated
// user can reach this (capability null).
import { useState } from 'preact/hooks';
import { useStore } from '../store/store.js';
import { api, sessionStore, refreshMe } from '../store/session.js';
import { Button, Card, Field, Input, PageHeader } from '../ui/kit.js';

export function AccountSettings() {
  const session = useStore(sessionStore);
  const [name, setName] = useState(session.name ?? '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setError('');
    setSaved(false);
    setBusy(true);
    try {
      await api.patch('/me', { body: { name: name.trim() } });
      await refreshMe();
      setSaved(true);
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not save your details.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="account-settings">
      <PageHeader title="My account" subtitle="Your details in this system." />

      <Card class="max-w-xl p-5">
        <Field label="Display name">
          <Input
            data-testid="account-name"
            placeholder="Your name"
            value={name}
            onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter') void save();
            }}
          />
        </Field>

        <div class="mt-3 flex items-center gap-3">
          <Button data-testid="account-save" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          {saved ? <span class="text-sm text-emerald-600">Saved ✓</span> : null}
        </div>
        {error ? (
          <p data-testid="account-error" class="mt-2 text-sm text-rose-600">
            {error}
          </p>
        ) : null}

        {/* Read-only identity, managed elsewhere. */}
        <div class="mt-6 space-y-3 border-t border-stone-100 pt-4 text-sm">
          <div class="flex items-center justify-between gap-3">
            <span class="text-stone-500">Email</span>
            <span data-testid="account-email" class="font-mono text-ink-900">{session.email ?? '—'}</span>
          </div>
          <p class="text-xs text-stone-400">Email and password are managed by your login provider.</p>
          <div class="flex items-center justify-between gap-3">
            <span class="text-stone-500">Role (this workspace)</span>
            <span class="capitalize text-ink-900">{session.role ?? '—'}</span>
          </div>
          <p class="text-xs text-stone-400">Your role is set by a workspace owner.</p>
        </div>
      </Card>
    </section>
  );
}
