// A tiny signal the AppShell watches to re-fetch configuration readiness (the Company /
// Workspace settings nav badges) WITHOUT a route change. Config screens that change what
// readiness depends on — connectors, sending domains, senders, R2 storage — call
// `refreshReadiness()` after a successful mutation so the badges update immediately.
import { createStore, type Store } from './store.js';

export const readinessStore: Store<number> = createStore<number>(0);

/** Bump the signal → AppShell re-fetches /company/readiness and updates the nav badges. */
export function refreshReadiness(): void {
  readinessStore.set((n) => n + 1);
}
