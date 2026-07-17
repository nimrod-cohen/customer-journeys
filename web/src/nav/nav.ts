// Capability-driven navigation (§3A, §12). The Nav is built from the user's
// effective role via `can()` (the SAME §3A matrix the backend enforces) — the UI
// shows only what the role permits. This is UX only; the SERVER still enforces
// every route independently (a hidden link is not a security boundary). Each nav
// item declares the capability it needs; items with `null` are always visible to
// any authenticated user.
import { can } from '@cdp/tenancy';
import type { Capability, Role } from '../types.js';

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  /** Capability required to SEE this item: a single capability, an ANY-OF list,
   *  or null (always visible). */
  readonly capability: Capability | readonly Capability[] | null;
}

/** The full nav catalogue (§12 screens). Order is the sidebar order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboards', label: 'Dashboards', path: '/dashboards', capability: 'manage_content' },
  { id: 'activity', label: 'Activity log', path: '/activity', capability: 'manage_content' },
  { id: 'segments', label: 'Segments', path: '/segments', capability: 'manage_content' },
  { id: 'broadcasts', label: 'Broadcasts', path: '/broadcasts', capability: 'manage_content' },
  { id: 'automations', label: 'Automations', path: '/automations', capability: 'manage_content' },
  // Asset management = email templates + image gallery tabs on one screen.
  { id: 'templates', label: 'Asset management', path: '/templates', capability: 'manage_content' },
  // The email editor itself (/editor) has no standalone nav item — it is reached
  // from the Templates list and from the "Design email" action on Broadcasts.
  { id: 'profiles', label: 'Profiles', path: '/profiles', capability: 'manage_content' },
  { id: 'suppressions', label: 'Suppressions', path: '/suppressions', capability: 'manage_content' },
  // Company settings holds the company/workspaces tab AND the Billing & usage tab.
  // Visible to anyone who can manage the company OR view billing (e.g. accounting).
  { id: 'company', label: 'Company settings', path: '/company', capability: ['manage_workspace_users', 'view_billing'] },
  // Workspace settings holds members/roles, the per-workspace sending domains
  // ("Sending domains" tab at /settings/domains) AND the subscription topics admin
  // ("Topics" tab at /settings/topics) — no separate nav items.
  { id: 'settings', label: 'Workspace settings', path: '/settings', capability: 'manage_workspace_users' },
  { id: 'admin', label: 'System admin', path: '/admin', capability: 'view_all_workspaces' },
  // Help is reference material — always visible to any authenticated user.
  { id: 'help', label: 'Help', path: '/help', capability: null },
];

/**
 * Build the nav for a role via `can()`. A null role (logged out / no workspace)
 * yields an empty nav. Items requiring no capability are always included.
 */
export function buildNav(role: Role | null): NavItem[] {
  if (role === null) return [];
  const allowed = (cap: NavItem['capability']): boolean =>
    cap === null || (Array.isArray(cap) ? cap.some((c) => can(role, c)) : can(role, cap as Capability));
  return NAV_ITEMS.filter((item) => allowed(item.capability));
}
