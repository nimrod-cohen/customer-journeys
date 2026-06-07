// Auth/session store + workspace-switch store (§12). Holds the bearer token (the
// active workspace_id + role live INSIDE it), the resolved identity, and the
// user's memberships for the switcher. Switching calls POST /workspace/switch
// which re-issues a token with the new active workspace; the store swaps the
// token and reloads /me so the whole app re-scopes — with no cross-bleed (the new
// token is the only scope source).
import { createStore, type Store } from './store.js';
import type { Role, WorkspaceRole } from '../types.js';
import { createApiClient, type ApiClient } from '../api/client.js';

export interface Membership {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  /** Human-friendly workspace name (the id is internal, never shown). */
  readonly name?: string;
}

export interface Session {
  readonly token: string | null;
  readonly sub: string | null;
  /** The signed-in user's email (shown instead of the internal user id). */
  readonly email: string | null;
  readonly workspaceId: string | null;
  /** The effective role for capability checks: workspace role or 'system-admin'. */
  readonly role: Role | null;
  readonly isPlatformAdmin: boolean;
  readonly memberships: readonly Membership[];
}

const EMPTY: Session = {
  token: null,
  sub: null,
  email: null,
  workspaceId: null,
  role: null,
  isPlatformAdmin: false,
  memberships: [],
};

// Persist the session across page reloads. The bearer token carries the active
// workspace_id + role and is the single scope source; we cache the resolved
// identity too so the app rehydrates without a flash, then revalidate via /me.
const STORAGE_KEY = 'cdp.session';

function loadPersisted(): Session | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s && typeof s.token === 'string' && s.token ? { ...EMPTY, ...s } : null;
  } catch {
    return null;
  }
}

function persist(s: Session): void {
  try {
    if (s.token) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (e.g. tests / private mode) — in-memory only */
  }
}

/** The global session store (rehydrated from localStorage on first load). */
export const sessionStore: Store<Session> = createStore<Session>(loadPersisted() ?? EMPTY);

// Mirror every session change to localStorage (login/switch/refresh/logout).
sessionStore.subscribe(persist);

/** An apiClient bound to the session store's current token. */
export const api: ApiClient = createApiClient({
  getToken: () => sessionStore.get().token,
});

/**
 * Re-validate a rehydrated session on boot: if a persisted token exists, refresh
 * the identity from /me; if the token is no longer valid (401), clear it so the
 * user lands on Login rather than a broken session.
 */
export async function restoreSession(): Promise<void> {
  if (!sessionStore.get().token) return;
  try {
    await refreshMe();
  } catch {
    logout();
  }
}

/** Compute the effective role from a workspace role + platform-admin flag. */
export function effectiveRole(role: WorkspaceRole | null, isPlatformAdmin: boolean): Role | null {
  if (isPlatformAdmin) return 'system-admin';
  return role;
}

interface LoginResponse {
  token: string;
  sub: string;
  workspace_id: string | null;
  is_platform_admin: boolean;
  memberships: Membership[];
}

interface MeResponse {
  sub: string;
  email: string;
  workspace_id: string;
  role: WorkspaceRole | null;
  is_platform_admin: boolean;
  memberships: Membership[];
}

/** Dev login: authenticate email + password, mint a token, then load /me. */
export async function login(email: string, password: string): Promise<void> {
  const res = await api.post<LoginResponse>('/auth/dev-login', {
    body: { email, password },
    // dev-login selects the initial active workspace — a session endpoint, not a
    // data request, so the workspace_id guard is intentionally bypassed here.
    allowWorkspaceId: true,
  });
  sessionStore.set((s) => ({
    ...s,
    token: res.token,
    sub: res.sub,
    workspaceId: res.workspace_id,
    isPlatformAdmin: res.is_platform_admin,
    memberships: res.memberships,
  }));
  await refreshMe();
}

/** Reload the resolved identity (role + active workspace) for the current token. */
export async function refreshMe(): Promise<void> {
  const me = await api.get<MeResponse>('/me');
  sessionStore.set((s) => ({
    ...s,
    sub: me.sub,
    email: me.email,
    workspaceId: me.workspace_id,
    role: effectiveRole(me.role, me.is_platform_admin),
    isPlatformAdmin: me.is_platform_admin,
    memberships: me.memberships,
  }));
}

interface SwitchResponse {
  token: string;
  workspace_id: string;
  role: WorkspaceRole | null;
  is_platform_admin: boolean;
}

/**
 * Switch the active workspace. Re-issues the token (new active workspace_id),
 * swaps it into the store, and reloads /me so every screen re-scopes. Because the
 * token is the ONLY scope source, there is no cross-bleed from the old workspace.
 */
export async function switchWorkspace(workspaceId: string): Promise<void> {
  const res = await api.post<SwitchResponse>('/workspace/switch', {
    body: { workspace_id: workspaceId },
    // The switch endpoint legitimately selects a new active workspace — the one
    // exception to the "no workspace_id in body" guard (it's not scoping data).
    allowWorkspaceId: true,
  });
  sessionStore.set((s) => ({
    ...s,
    token: res.token,
    workspaceId: res.workspace_id,
    role: effectiveRole(res.role, res.is_platform_admin),
  }));
  await refreshMe();
}

/** Log out: clear the session entirely. */
export function logout(): void {
  sessionStore.set(EMPTY);
}
