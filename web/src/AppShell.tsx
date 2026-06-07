// AppShell (§12): the authenticated layout — capability-driven Nav (buildNav via
// can()), a WorkspaceSwitcher (reuse the session store's switchWorkspace), and
// the routed screen body. The Nav shows only what the active role permits; the
// switcher re-scopes the whole app by swapping the token.
import { useStore } from './store/store.js';
import { sessionStore, switchWorkspace, logout } from './store/session.js';
import { routeStore, navigate } from './router.js';
import { buildNav } from './nav/nav.js';
import { SegmentBuilder } from './screens/SegmentBuilder.js';
import { BroadcastComposer } from './screens/BroadcastComposer.js';
import { CampaignBuilder } from './screens/CampaignBuilder.js';
import { WorkspaceSettings } from './screens/WorkspaceSettings.js';
import { OnboardingWizard } from './screens/OnboardingWizard.js';
import { SystemAdminConsole } from './screens/SystemAdminConsole.js';
import {
  Dashboards,
  ProfileExplorer,
  SuppressionList,
  BillingUsageView,
} from './screens/SimpleScreens.js';
import { EmailEditor } from './EmailEditor.js';
import type { JSX } from 'preact';

function screenFor(path: string): JSX.Element {
  switch (path) {
    case '/segments':
      return <SegmentBuilder />;
    case '/broadcasts':
      return <BroadcastComposer />;
    case '/campaigns':
      return <CampaignBuilder />;
    case '/editor':
      return <EmailEditor />;
    case '/profiles':
      return <ProfileExplorer />;
    case '/suppressions':
      return <SuppressionList />;
    case '/billing':
      return <BillingUsageView />;
    case '/settings':
      return <WorkspaceSettings />;
    case '/onboarding':
      return <OnboardingWizard />;
    case '/admin':
      return <SystemAdminConsole />;
    case '/dashboards':
    default:
      return <Dashboards />;
  }
}

export function AppShell() {
  const session = useStore(sessionStore);
  const route = useStore(routeStore);
  const nav = buildNav(session.role);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'system-ui' }}>
      <aside data-testid="app-nav" style={{ width: 220, borderRight: '1px solid #ddd', padding: 12 }}>
        <div data-testid="active-role" style={{ fontSize: 12, color: '#666' }}>
          role: {session.role ?? '—'}
        </div>
        <WorkspaceSwitcher />
        <nav>
          {nav.map((item) => (
            <a
              data-testid={`nav-${item.id}`}
              key={item.id}
              href={`#${item.path}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(item.path);
              }}
              style={{
                display: 'block',
                padding: '6px 0',
                fontWeight: route === item.path ? 700 : 400,
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <button data-testid="logout" type="button" onClick={logout}>
          Log out
        </button>
      </aside>
      <main data-testid="app-body" style={{ flex: 1, padding: 24 }}>
        {screenFor(route)}
      </main>
    </div>
  );
}

function WorkspaceSwitcher() {
  const session = useStore(sessionStore);
  return (
    <div data-testid="workspace-switcher" style={{ margin: '8px 0' }}>
      <label style={{ fontSize: 12, color: '#666' }}>Workspace</label>
      <select
        data-testid="workspace-select"
        value={session.workspaceId ?? ''}
        onChange={(e) => void switchWorkspace((e.target as HTMLSelectElement).value)}
      >
        {session.memberships.map((m) => (
          <option key={m.workspaceId} value={m.workspaceId}>
            {m.workspaceId} ({m.role})
          </option>
        ))}
        {session.isPlatformAdmin && session.workspaceId &&
        !session.memberships.some((m) => m.workspaceId === session.workspaceId) ? (
          <option value={session.workspaceId}>{session.workspaceId} (admin)</option>
        ) : null}
      </select>
    </div>
  );
}
