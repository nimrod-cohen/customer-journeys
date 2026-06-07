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

/** Navigate to a path (updates the hash). */
export function navigate(path: string): void {
  if (globalThis.location) globalThis.location.hash = path;
  routeStore.set(path);
}

/** Wire the hashchange listener (call once at boot). */
export function initRouter(): void {
  globalThis.addEventListener?.('hashchange', () => routeStore.set(currentPath()));
}
