// A tiny hash-based router (no dep). Hash routing avoids server-side rewrite
// config for the SPA and is reliable in the Playwright e2e. The current route is
// a store so AppShell re-renders on navigation.
import { createStore, type Store } from './store/store.js';

export const routeStore: Store<string> = createStore<string>(currentPath());

function currentPath(): string {
  const h = globalThis.location?.hash ?? '';
  const p = h.startsWith('#') ? h.slice(1) : h;
  return p || '/';
}

// An optional navigation guard. A screen with unsaved changes (e.g. the segment
// builder) registers one; it's consulted before EVERY in-app navigation and on
// browser back/forward. Returning false (or a Promise resolving false) cancels
// the navigation and we stay put. Only one guard is active at a time.
type NavGuard = (to: string) => boolean | Promise<boolean>;
let navGuard: NavGuard | null = null;

// The route we've actually committed to. Used to revert the hash when a guard
// rejects a browser back/forward (which mutates location.hash before we run).
let committed = currentPath();

export function setNavGuard(guard: NavGuard | null): void {
  navGuard = guard;
}

function commit(path: string): void {
  committed = path;
  if (globalThis.location && currentPath() !== path) globalThis.location.hash = path;
  routeStore.set(path);
}

/** Navigate to a path (updates the hash), unless a guard cancels it. */
export function navigate(path: string): void {
  if (navGuard && path !== committed) {
    void Promise.resolve(navGuard(path)).then((ok) => {
      if (ok) commit(path);
    });
    return;
  }
  commit(path);
}

/** Wire the hashchange listener (call once at boot). */
export function initRouter(): void {
  globalThis.addEventListener?.('hashchange', () => {
    const to = currentPath();
    if (to === committed) return; // our own commit(), or a revert — ignore
    if (navGuard) {
      void Promise.resolve(navGuard(to)).then((ok) => {
        if (ok) commit(to);
        else if (globalThis.location) globalThis.location.hash = committed; // revert
      });
    } else {
      commit(to);
    }
  });
}
