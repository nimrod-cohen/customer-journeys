// Login screen (§12). Email + password dev login (a real Supabase login replaces
// this). On success the session store holds a token carrying the active
// workspace_id + role; the app re-renders into the AppShell.
import { useState } from 'preact/hooks';
import { DEV_USERS } from '@cdp/shared';
import { login } from '../store/session.js';
import { Button, Input } from '../ui/kit.js';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError((err as { error?: string })?.error ?? 'login failed');
    }
  };

  return (
    <div class="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div class="relative hidden overflow-hidden bg-gradient-to-br from-ink-950 via-ink-900 to-brand-900 lg:block">
        <div
          class="absolute inset-0 opacity-30"
          style="background-image: radial-gradient(40rem 40rem at 70% 20%, rgba(45,212,191,0.35), transparent 60%), radial-gradient(30rem 30rem at 20% 90%, rgba(20,184,166,0.25), transparent 60%);"
        />
        <div class="relative flex h-full flex-col justify-between p-12 text-white">
          <div class="flex items-center gap-3">
            <span class="grid h-10 w-10 place-items-center rounded-xl bg-brand-500 text-ink-950 shadow-glow">
              <svg viewBox="0 0 24 24" fill="none" class="h-6 w-6" stroke="currentColor" stroke-width="2">
                <path d="M3 12c4-7 14-7 18 0-4 7-14 7-18 0Z" stroke-linejoin="round" />
                <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <span class="font-display text-lg font-bold">Customer Journeys</span>
          </div>
          <div>
            <h1 class="max-w-md font-display text-4xl font-bold leading-tight text-white">
              Reach the right customer, at the right moment.
            </h1>
            <p class="mt-4 max-w-md text-stone-300">
              Segments, broadcasts and multi-step journeys — across every workspace, with tenant
              isolation built in.
            </p>
          </div>
          <div class="flex gap-6 text-sm text-stone-400">
            <span>Multi-tenant</span>
            <span>·</span>
            <span>Serverless</span>
            <span>·</span>
            <span>Deliverability-first</span>
          </div>
        </div>
      </div>

      {/* Form panel */}
      <div class="flex items-center justify-center px-6 py-12">
        <div class="w-full max-w-sm animate-fade-up">
          <h2 class="font-display text-2xl font-bold text-ink-950">Sign in</h2>
          <p class="mt-1 text-sm text-stone-500">Enter your email and password to continue.</p>

          <form onSubmit={onSubmit} data-testid="login-form" class="mt-8 space-y-4">
            <div>
              <label class="label" for="login-email">
                Email
              </label>
              <Input
                id="login-email"
                data-testid="login-email"
                type="email"
                autocomplete="username"
                value={email}
                onInput={(e: Event) => setEmail((e.target as HTMLInputElement).value)}
                placeholder="you@company.com"
              />
            </div>
            <div>
              <label class="label" for="login-password">
                Password
              </label>
              <Input
                id="login-password"
                data-testid="login-password"
                type="password"
                autocomplete="current-password"
                value={password}
                onInput={(e: Event) => setPassword((e.target as HTMLInputElement).value)}
                placeholder="••••••••"
              />
            </div>
            <Button data-testid="login-submit" type="submit" class="w-full">
              Sign in
            </Button>
          </form>

          {error ? (
            <p
              data-testid="login-error"
              class="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200"
            >
              {error}
            </p>
          ) : null}

          {/* DEV-ONLY: seeded credentials (replaced by Supabase Auth in prod). */}
          <div class="mt-8 rounded-lg border border-stone-200 bg-white/60 p-3">
            <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              Dev credentials
            </p>
            <ul class="space-y-1.5 text-xs">
              {DEV_USERS.map((u) => (
                <li key={u.email} class="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setEmail(u.email);
                      setPassword(u.password);
                    }}
                    class="font-mono text-brand-700 hover:underline"
                    title={`Fill ${u.label}`}
                  >
                    {u.email}
                  </button>
                  <span class="text-stone-400">{u.label}</span>
                </li>
              ))}
            </ul>
            <p class="mt-2 text-[11px] text-stone-400">Click an email to autofill. Password shown on fill.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
