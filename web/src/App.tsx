// Root App (§12): shows Login when logged out, the AppShell when authenticated.
// A token in the session store (carrying the active workspace_id + role) is the
// single source of "logged in".
import { useStore } from './store/store.js';
import { sessionStore } from './store/session.js';
import { Login } from './screens/Login.js';
import { CreateFirstWorkspace } from './screens/CreateFirstWorkspace.js';
import { AppShell } from './AppShell.js';
import { PublicDocs } from './screens/ApiDocs.js';

export function App() {
  const session = useStore(sessionStore);
  // Public API reference at /docs — readable by integrators WITHOUT logging in.
  // Checked before the auth gate; the server serves the SPA shell at that path.
  if (typeof window !== 'undefined' && window.location.pathname === '/docs') return <PublicDocs />;
  if (!session.token) return <Login />;
  // A logged-in OWNER who registered a company but hasn't created a workspace yet
  // must create one first (needs_workspace). Other workspace-less users go straight
  // to the shell: platform admins operate cross-tenant, and an ACCOUNTING user is
  // company-level (billing only) with no workspace by design.
  if (!session.isPlatformAdmin && !session.workspaceId && session.needsWorkspace) {
    return <CreateFirstWorkspace />;
  }
  return <AppShell />;
}
