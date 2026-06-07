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
  /** The capability required to SEE this item (null = always visible). */
  readonly capability: Capability | null;
}

/** The full nav catalogue (§12 screens). Order is the sidebar order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboards', label: 'Dashboards', path: '/dashboards', capability: 'manage_content' },
  { id: 'segments', label: 'Segments', path: '/segments', capability: 'manage_content' },
  { id: 'broadcasts', label: 'Broadcasts', path: '/broadcasts', capability: 'manage_content' },
  { id: 'campaigns', label: 'Campaigns', path: '/campaigns', capability: 'manage_content' },
  { id: 'editor', label: 'Email editor', path: '/editor', capability: 'manage_content' },
  { id: 'profiles', label: 'Profiles', path: '/profiles', capability: 'manage_content' },
  { id: 'suppressions', label: 'Suppressions', path: '/suppressions', capability: 'manage_content' },
  { id: 'billing', label: 'Billing & usage', path: '/billing', capability: 'view_billing' },
  { id: 'settings', label: 'Workspace settings', path: '/settings', capability: 'manage_workspace_users' },
  { id: 'onboarding', label: 'Domain onboarding', path: '/onboarding', capability: 'manage_sending_domain' },
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
  return NAV_ITEMS.filter((item) => item.capability === null || can(role, item.capability));
}
