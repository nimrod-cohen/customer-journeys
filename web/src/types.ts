// Re-export the shared role/capability types so SPA modules have a single source
// of truth that matches the backend (§3A).
export type { Role, WorkspaceRole, Capability } from '@cdp/shared';
