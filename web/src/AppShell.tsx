// AppShell (§12): the authenticated layout — capability-driven Nav (buildNav via
// can()), a WorkspaceSwitcher (reuse the session store's switchWorkspace), and
// the routed screen body. The Nav shows only what the active role permits; the
// switcher re-scopes the whole app by swapping the token. (Visual redesign:
// Tailwind, dark "ink" sidebar; all data-testid attributes preserved.)
import { useEffect } from 'preact/hooks';
import { useStore } from './store/store.js';
import { sessionStore, switchWorkspace, logout } from './store/session.js';
import { routeStore, navigate } from './router.js';
import { buildNav } from './nav/nav.js';
import { ICONS } from './ui/icons.js';
import { SegmentBuilder } from './screens/SegmentBuilder.js';
import { SegmentsList } from './screens/SegmentsList.js';
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
import { ProfileDetail } from './screens/ProfileDetail.js';
import { EmailEditor } from './EmailEditor.js';
import type { JSX } from 'preact';

/** True when `route` is `item` or a sub-route of it (e.g. /profiles/<id> under /profiles). */
function underNav(route: string, itemPath: string): boolean {
  return route === itemPath || route.startsWith(`${itemPath}/`);
}

function screenFor(path: string): JSX.Element {
  // Profile detail is a sub-route of /profiles carrying the id in the path.
  if (path.startsWith('/profiles/')) {
    return <ProfileDetail id={path.slice('/profiles/'.length)} />;
  }
  // Segments: list at /segments; the designated create/edit builder at
  // /segments/new and /segments/:id.
  if (path === '/segments') return <SegmentsList />;
  if (path.startsWith('/segments/')) {
    const rest = path.slice('/segments/'.length);
    return rest === 'new' ? <SegmentBuilder /> : <SegmentBuilder id={rest} />;
  }
  switch (path) {
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

export function AppShell(): JSX.Element {
  const session = useStore(sessionStore);
  const route = useStore(routeStore);
  const nav = buildNav(session.role);

  // Land on a permitted screen: if the current route isn't in the role's nav
  // (e.g. a system-admin with no active workspace can't open /dashboards),
  // fall back to the first permitted item (the System Admin console for them).
  const permitted = nav.some((n) => underNav(route, n.path));
  const effectiveRoute = permitted ? route : (nav[0]?.path ?? route);
  useEffect(() => {
    if (!permitted && nav[0] && route !== nav[0].path) navigate(nav[0].path);
  }, [permitted, route, nav]);

  return (
    <div class="flex min-h-screen">
      <aside
        data-testid="app-nav"
        class="sticky top-0 flex h-screen w-64 shrink-0 flex-col gap-1 bg-gradient-to-b from-ink-950 to-ink-900 px-3 py-4 text-stone-300"
      >
        {/* Brand */}
        <div class="flex items-center gap-2.5 px-2 pb-3">
          <span class="grid h-9 w-9 place-items-center rounded-xl bg-brand-500 text-ink-950 shadow-glow">
            <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5" stroke="currentColor" stroke-width="2">
              <path d="M3 12c4-7 14-7 18 0-4 7-14 7-18 0Z" stroke-linejoin="round" />
              <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <div class="leading-tight">
            <div class="font-display text-[15px] font-bold text-white">Customer Journeys</div>
            <div class="text-[11px] text-stone-400">Marketing CDP</div>
          </div>
        </div>

        <WorkspaceSwitcher />

        <nav class="mt-1 flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {nav.map((item) => {
            const active = underNav(route, item.path);
            return (
              <a
                data-testid={`nav-${item.id}`}
                key={item.id}
                href={`#${item.path}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(item.path);
                }}
                class={`nav-link ${active ? 'nav-link-active' : ''}`}
              >
                <span class={active ? 'text-brand-300' : 'text-stone-400'}>{ICONS[item.id]}</span>
                {item.label}
              </a>
            );
          })}
        </nav>

        {/* Footer: role + logout */}
        <div class="mt-2 border-t border-white/10 px-2 pt-3">
          <div class="mb-2 flex items-center gap-2">
            <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-bold uppercase text-brand-300">
              {(session.email ?? session.role ?? '?').slice(0, 2)}
            </span>
            <div class="min-w-0 leading-tight">
              <div class="truncate text-sm font-semibold text-white" title={session.email ?? ''}>
                {session.email ?? 'Signed in'}
              </div>
              <div data-testid="active-role" class="text-[11px] capitalize text-stone-400">
                {session.role ?? '—'}
              </div>
            </div>
          </div>
          <button
            data-testid="logout"
            type="button"
            onClick={logout}
            class="w-full rounded-lg border border-white/10 px-3 py-2 text-sm font-medium text-stone-300 transition hover:bg-white/5 hover:text-white"
          >
            Log out
          </button>
        </div>
      </aside>

      <main data-testid="app-body" class="flex-1 overflow-x-hidden px-8 py-8">
        <div key={effectiveRoute} class="mx-auto max-w-6xl animate-fade-up">
          {screenFor(effectiveRoute)}
        </div>
      </main>
    </div>
  );
}

function shortWs(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function WorkspaceSwitcher(): JSX.Element {
  const session = useStore(sessionStore);
  const adminExtra =
    session.isPlatformAdmin &&
    session.workspaceId &&
    !session.memberships.some((m) => m.workspaceId === session.workspaceId);
  return (
    <div data-testid="workspace-switcher" class="px-2 pb-2">
      <label class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-500">
        Workspace
      </label>
      <div class="relative">
        <select
          data-testid="workspace-select"
          value={session.workspaceId ?? ''}
          onChange={(e) => void switchWorkspace((e.target as HTMLSelectElement).value)}
          class="w-full appearance-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 pr-8 text-sm font-medium text-white outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30"
        >
          {session.memberships.map((m) => (
            <option key={m.workspaceId} value={m.workspaceId} class="text-ink-900">
              {m.name ?? shortWs(m.workspaceId)} · {m.role}
            </option>
          ))}
          {adminExtra ? (
            <option value={session.workspaceId ?? ''} class="text-ink-900">
              {shortWs(session.workspaceId ?? '')} · admin
            </option>
          ) : null}
        </select>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          class="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
        >
          <path d="M6 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
    </div>
  );
}
