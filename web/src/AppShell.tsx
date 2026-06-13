// AppShell (§12): the authenticated layout — capability-driven Nav (buildNav via
// can()), a WorkspaceSwitcher (reuse the session store's switchWorkspace), and
// the routed screen body. The Nav shows only what the active role permits; the
// switcher re-scopes the whole app by swapping the token. (Visual redesign:
// Tailwind, dark "ink" sidebar; all data-testid attributes preserved.)
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from './store/store.js';
import { sessionStore, switchWorkspace, logout, api } from './store/session.js';
import { routeStore, navigate } from './router.js';
import { buildNav } from './nav/nav.js';
import { ICONS } from './ui/icons.js';
import { SegmentBuilder } from './screens/SegmentBuilder.js';
import { SegmentsList } from './screens/SegmentsList.js';
import { BroadcastComposer, BroadcastWizard } from './screens/BroadcastComposer.js';
import { CampaignBuilder } from './screens/CampaignBuilder.js';
import { WorkspaceSettings } from './screens/WorkspaceSettings.js';
import { CompanySettings } from './screens/CompanySettings.js';
import { SendingDomainsList } from './screens/SendingDomainsList.tsx';
import { SendingDomainDetail } from './screens/SendingDomainDetail.tsx';
import { SystemAdminConsole } from './screens/SystemAdminConsole.js';
import {
  Dashboards,
  ProfileExplorer,
  SuppressionList,
  BillingUsageView,
} from './screens/SimpleScreens.js';
import { ProfileDetail } from './screens/ProfileDetail.js';
import { TemplatesList } from './screens/TemplatesList.js';
import { Help } from './screens/Help.js';
import { Activity } from './screens/Activity.js';
import { TemplateEditor } from './screens/TemplateEditor.tsx';
import { DialogHost } from './ui/dialog.tsx';
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
  // Broadcasts: list at /broadcasts; the creation/edit wizard at /broadcasts/new
  // and /broadcasts/:id.
  if (path.startsWith('/broadcasts/')) {
    const rest = path.slice('/broadcasts/'.length);
    return rest === 'new' ? <BroadcastWizard /> : <BroadcastWizard id={rest} />;
  }
  // The email editor: new template at /editor, edit one at /editor/:id.
  if (path.startsWith('/editor/')) {
    return <TemplateEditor id={path.slice('/editor/'.length)} />;
  }
  // Sending domains: list at /onboarding; the per-domain setup screen at
  // /onboarding/new and /onboarding/:id.
  if (path === '/onboarding') return <SendingDomainsList />;
  if (path.startsWith('/onboarding/')) {
    const rest = path.slice('/onboarding/'.length);
    return rest === 'new' ? <SendingDomainDetail /> : <SendingDomainDetail id={rest} />;
  }
  switch (path) {
    case '/broadcasts':
      return <BroadcastComposer />;
    case '/templates':
      return <TemplatesList />;
    case '/campaigns':
      return <CampaignBuilder />;
    case '/editor':
      return <TemplateEditor />;
    case '/profiles':
      return <ProfileExplorer />;
    case '/suppressions':
      return <SuppressionList />;
    case '/billing':
      return <BillingUsageView />;
    case '/settings':
      return <WorkspaceSettings />;
    case '/company':
      return <CompanySettings />;
    case '/admin':
      return <SystemAdminConsole />;
    case '/help':
      return <Help />;
    case '/activity':
      return <Activity />;
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
  // The email editor has no nav item (reached from Broadcasts/Campaigns), but is
  // still permitted for anyone who can manage content (i.e. has those screens).
  const canEditor = (route === '/editor' || route.startsWith('/editor/')) && nav.some((n) => n.id === 'broadcasts');
  const permitted = canEditor || nav.some((n) => underNav(route, n.path));
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

        {/* Platform admins get a Company → Workspace picker (pick a company, then
            a workspace within it). Everyone else gets the membership switcher. */}
        {session.isPlatformAdmin ? <CompanyWorkspacePicker /> : <WorkspaceSwitcher />}

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
          <p data-testid="app-version" class="mt-2 text-center text-[10px] lowercase tracking-wide text-stone-500">
            v{__APP_VERSION__}
            {__APP_COMMIT__ ? ` · ${__APP_COMMIT__}` : ''}
          </p>
        </div>
      </aside>

      <DialogHost />
      <main data-testid="app-body" class="flex-1 overflow-x-hidden px-8 py-8">
        {/* Key by route AND active workspace so switching company/workspace
            remounts the screen and re-fetches its (now re-scoped) data, even when
            the route is unchanged (e.g. switching while already on Dashboards). */}
        <div key={`${effectiveRoute}:${session.workspaceId ?? ''}`} class="mx-auto max-w-6xl animate-fade-up">
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
              {m.name ?? shortWs(m.workspaceId)}
            </option>
          ))}
          {adminExtra ? (
            <option value={session.workspaceId ?? ''} class="text-ink-900">
              {session.workspaceName ?? shortWs(session.workspaceId ?? '')} · admin
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

interface AdminWorkspace {
  id: string;
  name: string;
  status: string;
}
interface AdminCompany {
  id: string;
  name: string;
  status: string;
  workspaces: AdminWorkspace[];
}

/**
 * Platform-admin Company → Workspace picker. A SEARCHABLE company list (from
 * /admin/companies, audited); choosing a company reveals its workspaces, and
 * choosing a workspace switches the active scope so the super-admin sees exactly
 * what that workspace's admin sees (the system-admin role carries every workspace
 * capability). Tenant isolation is unchanged — the active scope is still a single
 * workspace; the company is just the parent grouping.
 */
function CompanyWorkspacePicker(): JSX.Element {
  const session = useStore(sessionStore);
  const [companies, setCompanies] = useState<AdminCompany[]>([]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // Which company's workspaces are shown — defaults to the active workspace's
  // company, and follows the admin's company selection.
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  // Re-fetch on navigation so the picker stays in sync with the System Admin
  // screen (where companies/workspaces are created, renamed, deleted).
  const route = useStore(routeStore);

  useEffect(() => {
    void api
      .get<{ companies: AdminCompany[] }>('/admin/companies')
      .then((r) => setCompanies(r.companies))
      .catch(() => setCompanies([]));
  }, [route]);
  useEffect(() => {
    if (session.companyId) setSelectedCompanyId(session.companyId);
  }, [session.companyId]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selectedCompany =
    companies.find((c) => c.id === selectedCompanyId) ??
    companies.find((c) => c.id === session.companyId) ??
    null;
  const needle = q.trim().toLowerCase();
  const filtered = needle ? companies.filter((c) => c.name.toLowerCase().includes(needle)) : companies;

  const pickCompany = (id: string) => {
    setSelectedCompanyId(id);
    setOpen(false);
    setQ('');
    // If the company has exactly one workspace, enter it directly.
    const c = companies.find((x) => x.id === id);
    if (c && c.workspaces.length === 1 && c.workspaces[0]!.id !== session.workspaceId) {
      void switchWorkspace(c.workspaces[0]!.id).then(() => navigate('/dashboards'));
    }
  };
  const pickWorkspace = (id: string) => {
    if (id && id !== session.workspaceId) void switchWorkspace(id).then(() => navigate('/dashboards'));
  };

  return (
    <div ref={ref} data-testid="company-picker" class="space-y-2 px-2 pb-2">
      <div class="relative">
        <label class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-500">
          Company
        </label>
        <button
          data-testid="company-current"
          onClick={() => setOpen((v) => !v)}
          class="flex w-full items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-sm font-medium text-white outline-none transition hover:bg-white/10 focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30"
        >
          <span class="truncate">{selectedCompany?.name ?? session.companyName ?? 'Select a company…'}</span>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" class="ml-2 h-4 w-4 shrink-0 text-stone-400">
            <path d="M6 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        {open ? (
          <div
            data-testid="company-menu"
            class="absolute left-0 right-0 z-40 mt-1 rounded-lg border border-stone-200 bg-white p-2 shadow-soft"
          >
            <input
              data-testid="company-search"
              type="search"
              autofocus
              value={q}
              onInput={(e: Event) => setQ((e.target as HTMLInputElement).value)}
              placeholder="Search companies…"
              class="w-full rounded-md border border-stone-200 px-2.5 py-1.5 text-sm text-ink-900 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30"
            />
            <div class="mt-1 max-h-64 overflow-y-auto">
              {filtered.map((c) => (
                <button
                  key={c.id}
                  data-testid="company-option"
                  data-id={c.id}
                  onClick={() => pickCompany(c.id)}
                  class="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-ink-800 hover:bg-stone-100"
                >
                  <span class="truncate">{c.name}</span>
                  <span class="shrink-0 text-[10px] uppercase tracking-wide text-stone-400">
                    {c.workspaces.length} ws
                  </span>
                </button>
              ))}
              {filtered.length === 0 ? <p class="px-2 py-2 text-xs text-stone-400">No companies match.</p> : null}
            </div>
          </div>
        ) : null}
      </div>

      {selectedCompany ? (
        <div class="relative">
          <label class="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-500">
            Workspace
          </label>
          <select
            data-testid="admin-workspace-select"
            value={selectedCompany.workspaces.some((w) => w.id === session.workspaceId) ? session.workspaceId ?? '' : ''}
            onChange={(e) => pickWorkspace((e.target as HTMLSelectElement).value)}
            class="w-full appearance-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 pr-8 text-sm font-medium text-white outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30"
          >
            <option value="" class="text-ink-900">
              {selectedCompany.workspaces.length ? 'Choose a workspace…' : 'No workspaces'}
            </option>
            {selectedCompany.workspaces.map((w) => (
              <option key={w.id} value={w.id} class="text-ink-900">
                {w.name}
              </option>
            ))}
          </select>
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            class="pointer-events-none absolute right-2.5 top-[34px] h-4 w-4 text-stone-400"
          >
            <path d="M6 8l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      ) : null}
    </div>
  );
}
