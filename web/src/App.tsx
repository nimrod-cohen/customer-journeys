// Root App (§12): shows Login when logged out, the AppShell when authenticated.
// A token in the session store (carrying the active workspace_id + role) is the
// single source of "logged in".
import { useStore } from './store/store.js';
import { sessionStore } from './store/session.js';
import { Login } from './screens/Login.js';
import { CreateFirstWorkspace } from './screens/CreateFirstWorkspace.js';
import { AppShell } from './AppShell.js';

export function App() {
  const session = useStore(sessionStore);
  if (!session.token) return <Login />;
  // A logged-in owner with no workspace (registered a company but hasn't created
  // a workspace yet) must create one before the main shell. Platform admins
  // legitimately have no active workspace and go straight to the shell.
  if (!session.isPlatformAdmin && !session.workspaceId) return <CreateFirstWorkspace />;
  return <AppShell />;
}
