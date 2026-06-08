// @cdp/shared — cross-cutting types, env/config, workspace-aware logging.
// See CDP-BUILD-SPEC.md §3, §3A, §6, §12, §13, §19, §21.

/** Workspace-scoped roles stored in workspace_users.role (§3A). */
export type WorkspaceRole = 'owner' | 'marketer' | 'accounting';

/**
 * The four-role model (§3A). `system-admin` is platform-level (cross-tenant),
 * derived from membership in `platform_admins` — NOT from workspace_users.role.
 * The other three are workspace-scoped.
 */
export type Role = WorkspaceRole | 'system-admin';

/** Lifecycle status of a workspace (§6). */
export type WorkspaceStatus = 'onboarding' | 'active' | 'suspended';

/**
 * The capabilities the API gates on (§3A capability matrix). Routes declare a
 * required capability; `requireCapability` checks it against the resolved role.
 */
export type Capability =
  | 'view_all_workspaces' // cross-tenant company/workspace listing (system-admin only)
  | 'manage_workspace_users' // members + roles
  | 'manage_sending_domain' // sending domain / dedicated-IP upgrade
  | 'manage_content' // segments, broadcasts, campaigns, templates, profiles
  | 'view_billing'; // billing / spend / usage view

/**
 * A user's membership of a single workspace (a `workspace_users` row, §6).
 * A user may hold different roles in different workspaces.
 */
export interface Membership {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
}

/**
 * The custom JWT claims the authorizer injects (§12). `workspace_id` is the
 * ACTIVE workspace; it is never read from a client body (§13).
 */
export interface ClaimSet {
  /** Supabase auth user id (the `sub` claim). */
  readonly sub: string;
  /** The active workspace id (the workspace switcher's selection). */
  readonly workspace_id: string | null;
  /** True when the user is in `platform_admins` (the cross-tenant role). */
  readonly is_platform_admin: boolean;
  /** The user's role in the active workspace (absent for platform-admin-only). */
  readonly role?: WorkspaceRole;
}

/**
 * Tenancy context resolved by the authorizer (admin API) or from the API key
 * (ingest). `workspace_id` is NEVER taken from a client payload (§7, §13).
 */
export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly userId?: string;
  readonly role?: WorkspaceRole;
  readonly isPlatformAdmin: boolean;
}

/**
 * The event envelope a producer sends to ingest (§7).
 *
 * CRITICAL (tenancy invariant, §7/§13): there is NO workspace_id field. The
 * workspace is derived from the API key at ingest, never from the client
 * payload — a company must not be able to spoof another's workspace.
 */
export interface EventEnvelope {
  /** Producer-supplied idempotency / dedupe key (§7). */
  readonly event_id: string;
  /**
   * The customer's EMAIL — the IDENTITY KEY (§6/§7). Events arrive from many
   * source systems; email is the one identifier that stitches a person's events
   * together, so it is REQUIRED and is the per-workspace merge key for profiles.
   */
  readonly email: string;
  /** Optional company-side id; stored as profile metadata, NOT the identity key. */
  readonly external_id?: string;
  /** Event type, e.g. `profile_created | progress | purchase`. */
  readonly type: string;
  /** ISO-8601 timestamp the event occurred. */
  readonly occurred_at: string;
  /** Arbitrary event attributes (merged into the profile on profile_created). */
  readonly attributes?: Record<string, unknown>;
}

/**
 * The message body ingest writes onto SQS FIFO and the processor consumes (§7).
 *
 * `workspace_id` here is TRUSTED: it was set by ingest from the API key lookup,
 * not by the client. `profile_id` is the resolved internal id (used as the FIFO
 * MessageGroupId). The original envelope rides along for the processor.
 */
export interface ProcessorMessage {
  readonly workspace_id: string;
  readonly profile_id: string;
  readonly envelope: EventEnvelope;
}

/**
 * The rolling per-profile aggregates the processor maintains (§6 `profile_features`).
 * Written by the processor's feature-upsert; read by the §8 segmentation engine.
 * `counters` is a per-event-type running tally (jsonb). All numeric fields are
 * non-null with DB defaults (total_events/monetary_total default 0).
 */
export interface ProfileFeatures {
  readonly profile_id: string;
  readonly workspace_id: string;
  readonly total_events: number;
  readonly last_event_at: string | null;
  readonly last_email_open_at: string | null;
  readonly counters: Record<string, number>;
  readonly monetary_total: number;
  readonly updated_at: string;
}

/**
 * Event types that count as an email open (drive `last_email_open_at`, §6/§10).
 * Opens are a SOFT engagement signal (Apple MPP inflates them, §10) — kept as a
 * small whitelist so feature logic and segments agree on what an "open" is.
 */
export const OPEN_EVENT_TYPES = ['email_open', 'open'] as const;

/**
 * Event types that count as purchase-like (contribute to `monetary_total`, §6).
 * The monetary amount is read from the event attributes (see extractAmount).
 */
export const PURCHASE_EVENT_TYPES = ['purchase', 'order_completed'] as const;

/** A row of the `workspace_api_keys` map (§6) — API Gateway key id → workspace. */
export interface WorkspaceApiKeyRow {
  readonly api_key_id: string;
  readonly workspace_id: string;
  readonly label?: string | null;
}

/**
 * The result of authorizing a decoded JWT against the caller's membership and
 * platform-admin status (§12). Produced by the authorizer's pure core and then
 * turned into an API Gateway policy.
 */
export interface AuthResult {
  /** Whether the request is allowed past the gateway. */
  readonly allowed: boolean;
  /** Principal (Supabase user id) — present whenever the token verified. */
  readonly principalId?: string;
  /** The claims to inject into the request context for downstream Lambdas. */
  readonly claims?: ClaimSet;
  /** The effective role used for capability checks (§3A). */
  readonly effectiveRole?: Role;
  /** Human-readable reason when denied (logged, not returned to clients). */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// DEV-ONLY auth fixtures. The local dev-login (services/local-api) authenticates
// email + password against this list and resolves to a seeded user id. In
// production this is entirely replaced by Supabase Auth — these credentials do
// not exist there. The userIds MUST match the e2e/seed user UUIDs.
// ---------------------------------------------------------------------------
export interface DevUser {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly label: string;
}

export const DEV_USERS: readonly DevUser[] = [
  {
    email: 'admin@journeys.dev',
    password: 'admin1234',
    userId: '0e2efe00-0000-4000-8000-0000000000b3',
    label: 'Platform admin (system-admin)',
  },
  {
    email: 'owner@acme.com',
    password: 'owner1234',
    userId: '0e2efe00-0000-4000-8000-0000000000b1',
    label: 'Owner — Acme (A) + Beta (B)',
  },
  {
    email: 'marketer@acme.com',
    password: 'marketer1234',
    userId: '0e2efe00-0000-4000-8000-0000000000b2',
    label: 'Marketer — Acme (A)',
  },
];

/** Resolve a dev user by email + password (constant work; dev-only). Returns null on mismatch. */
export function findDevUser(email: string, password: string): DevUser | null {
  const e = email.trim().toLowerCase();
  return DEV_USERS.find((u) => u.email.toLowerCase() === e && u.password === password) ?? null;
}
