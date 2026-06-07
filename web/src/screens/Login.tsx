// Login screen (§12). Dev login by seeded user id (a real Supabase login would
// replace this). On success the session store holds a token carrying the active
// workspace_id + role; the app re-renders into the AppShell.
import { useState } from 'preact/hooks';
import { login } from '../store/session.js';

export function Login() {
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');
    try {
      await login(userId.trim());
    } catch (err) {
      setError((err as { error?: string })?.error ?? 'login failed');
    }
  };

  return (
    <main style={{ maxWidth: 420, margin: '80px auto', fontFamily: 'system-ui' }}>
      <h1>CDP Admin</h1>
      <form onSubmit={onSubmit} data-testid="login-form">
        <label>
          User id
          <input
            data-testid="login-user-id"
            value={userId}
            onInput={(e) => setUserId((e.target as HTMLInputElement).value)}
            placeholder="seeded user uuid"
            style={{ display: 'block', width: '100%', margin: '8px 0' }}
          />
        </label>
        <button data-testid="login-submit" type="submit">
          Sign in
        </button>
      </form>
      {error ? (
        <p data-testid="login-error" style={{ color: 'crimson' }}>
          {error}
        </p>
      ) : null}
    </main>
  );
}
