// Login screen (§12). Email + password dev login (a real Supabase login replaces
// this). On success the session store holds a token carrying the active
// workspace_id + role; the app re-renders into the AppShell.
import { useState } from 'preact/hooks';
import { DEV_USERS } from '@cdp/shared';
import { login, register } from '../store/session.js';
import { Button, Input } from '../ui/kit.js';

export function Login() {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (isRegister) {
        await register({ name: name.trim(), email: email.trim(), password, companyName: companyName.trim() });
      } else {
        await login(email.trim(), password);
      }
    } catch (err) {
      setError((err as { error?: string })?.error ?? (isRegister ? 'registration failed' : 'login failed'));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: 'signin' | 'register') => {
    setMode(next);
    setError('');
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
          <h2 class="font-display text-2xl font-bold text-ink-950">
            {isRegister ? 'Create a company account' : 'Sign in'}
          </h2>
          <p class="mt-1 text-sm text-stone-500">
            {isRegister
              ? 'Set up your company and you’ll be its owner.'
              : 'Enter your email and password to continue.'}
          </p>

          <form onSubmit={onSubmit} data-testid="login-form" class="mt-8 space-y-4">
            {isRegister ? (
              <div>
                <label class="label" for="reg-company">
                  Company name
                </label>
                <Input
                  id="reg-company"
                  data-testid="register-company"
                  value={companyName}
                  onInput={(e: Event) => setCompanyName((e.target as HTMLInputElement).value)}
                  placeholder="Acme Inc."
                />
              </div>
            ) : null}
            {isRegister ? (
              <div>
                <label class="label" for="reg-name">
                  Your name
                </label>
                <Input
                  id="reg-name"
                  data-testid="register-name"
                  autocomplete="name"
                  value={name}
                  onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
                  placeholder="Jane Doe"
                />
              </div>
            ) : null}
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
                autocomplete={isRegister ? 'new-password' : 'current-password'}
                value={password}
                onInput={(e: Event) => setPassword((e.target as HTMLInputElement).value)}
                placeholder={isRegister ? 'at least 8 characters' : '••••••••'}
              />
            </div>
            <Button data-testid="login-submit" type="submit" class="w-full" loading={busy} disabled={busy}>
              {isRegister ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          <p class="mt-4 text-sm text-stone-500">
            {isRegister ? (
              <>
                Already have an account?{' '}
                <button type="button" data-testid="show-signin" class="font-semibold text-brand-700 hover:underline" onClick={() => switchMode('signin')}>
                  Sign in
                </button>
              </>
            ) : (
              <>
                New here?{' '}
                <button type="button" data-testid="show-register" class="font-semibold text-brand-700 hover:underline" onClick={() => switchMode('register')}>
                  Create a company account
                </button>
              </>
            )}
          </p>

          {error ? (
            <p
              data-testid="login-error"
              class="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200"
            >
              {error}
            </p>
          ) : null}

          {/* DEV-ONLY: seeded credentials (replaced by Supabase Auth in prod). */}
          {!isRegister ? (
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
          ) : null}
        </div>
      </div>
    </div>
  );
}
