// SetPassword — the public screen an invited user (accept invite) or a user who
// requested a reset lands on from their email link. It reads the one-time token from
// the URL hash, takes a new password, and on success is logged straight in (the
// session applyLogin re-renders the app into the shell). Pre-auth, no nav.
import { useState } from 'preact/hooks';
import { Button, Input } from '../ui/kit.js';
import { acceptInvite, resetPasswordWithToken } from '../store/session.js';

/** Read `token` from a hash link like `#/accept-invite?token=…`. */
function tokenFromHash(): string {
  const hash = globalThis.location?.hash ?? '';
  const q = hash.split('?')[1] ?? '';
  return new URLSearchParams(q).get('token') ?? '';
}

export function SetPassword({ mode }: { mode: 'invite' | 'reset' }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const token = tokenFromHash();

  const title = mode === 'invite' ? 'Accept your invite' : 'Choose a new password';
  const blurb =
    mode === 'invite'
      ? 'Set a password to activate your account and join your team.'
      : 'Set a new password for your account.';
  const cta = mode === 'invite' ? 'Set password & join' : 'Set new password';

  const submit = async (e: Event) => {
    e.preventDefault();
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm) return setError('The passwords don’t match.');
    setBusy(true);
    setError('');
    try {
      if (mode === 'invite') await acceptInvite(token, password);
      else await resetPasswordWithToken(token, password);
      // Logged in — send the app to its default landing.
      if (globalThis.location) globalThis.location.hash = '/';
    } catch (err) {
      setError((err as { error?: string })?.error ?? 'This link is invalid or has expired.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex min-h-screen items-center justify-center bg-stone-50 px-6 py-12">
      <div class="w-full max-w-sm animate-fade-up" data-testid="set-password-screen">
        <h2 class="font-display text-2xl font-bold text-ink-950">{title}</h2>
        <p class="mt-1 text-sm text-stone-500">{blurb}</p>

        {!token ? (
          <p data-testid="set-password-notoken" class="mt-6 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">
            This link is missing its token. Please open the exact link from your email.
          </p>
        ) : (
          <form onSubmit={submit} data-testid="set-password-form" class="mt-8 space-y-4">
            <div>
              <label class="label" for="set-password">
                New password
              </label>
              <Input
                id="set-password"
                data-testid="set-password"
                type="password"
                autocomplete="new-password"
                placeholder="At least 8 characters"
                value={password}
                onInput={(e: Event) => setPassword((e.target as HTMLInputElement).value)}
              />
            </div>
            <div>
              <label class="label" for="set-password-confirm">
                Confirm password
              </label>
              <Input
                id="set-password-confirm"
                data-testid="set-password-confirm"
                type="password"
                autocomplete="new-password"
                value={confirm}
                onInput={(e: Event) => setConfirm((e.target as HTMLInputElement).value)}
              />
            </div>
            {error ? (
              <p data-testid="set-password-error" class="text-sm text-rose-600">
                {error}
              </p>
            ) : null}
            <Button type="submit" data-testid="set-password-submit" loading={busy} class="w-full">
              {cta}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
