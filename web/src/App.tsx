// Root App (§12): shows Login when logged out, the AppShell when authenticated.
// A token in the session store (carrying the active workspace_id + role) is the
// single source of "logged in".
import { useStore } from './store/store.js';
import { sessionStore } from './store/session.js';
import { Login } from './screens/Login.js';
import { AppShell } from './AppShell.js';

export function App() {
  const session = useStore(sessionStore);
  return session.token ? <AppShell /> : <Login />;
}
