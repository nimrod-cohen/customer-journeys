// Campaign engine pure core (§9B). No I/O — the orchestrator (run.ts) and the
// enrollment orchestrator (enroll.ts) inject readers + a workspace-scoped tx
// runner + an SQS sender and wire these. Everything here is deterministic
// (injected clock) and unit-tested without AWS or Postgres.
//
// Two engine properties live here:
//   - IDEMPOTENT ADVANCE: the enrollment is advanced via a CAS on updated_at
//     (buildEnrollmentClaim + buildAdvanceEnrollment), so concurrent sweeps /
//     retries advance AT MOST once.
//   - EXACTLY-ONCE SENDS: action sends insert an outbox row with a stable
//     dedupe_key (campaign:<campaign>:<profile>:<node>) ON CONFLICT DO NOTHING,
//     then the Dispatcher's atomic claim sends once.
import { buildSegmentMatch } from '@cdp/segments';
import type { AstNode } from '@cdp/segments';
import { isWindowOpen, nextWindowOpening, zonedInputToUtcIso } from '@cdp/shared';
import {
  type Node,
  type WaitNode,
  type ConditionNode,
  type ActionNode,
  type WebhookAction,
} from './dsl.js';

/** The fallback workspace timezone when workspaces.settings has none (parity with handlers). */
export const DEFAULT_WORKSPACE_TZ = 'UTC';

/** A parameterized query ready for `pool.query(text, values)` (shared shape). */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/** The re-enrollment policy for a campaign (this phase: 'once' default). */
export type ReenrollmentPolicy = 'once' | 'always';

/** A side effect produced by processing a node (consumed by the orchestrator). */
export type SideEffect =
  | {
      /** Enqueue an email send through the Dispatcher (outbox + {outbox_id}). */
      readonly kind: 'send';
      /** The template to send. */
      readonly templateId: string;
      /** The node id this send originates from (drives the dedupe_key). */
      readonly nodeId: string;
    }
  | {
      /** Set a profile attribute (a workspace-scoped UPDATE). */
      readonly kind: 'set_attribute';
      readonly key: string;
      readonly value: unknown;
    }
  | {
      /**
       * Fire an outbound webhook (§9B). Collected during chainTick like a send,
       * but — like enqueueSends — EXECUTED AFTER THE TX COMMITS (an external HTTP
       * call must never hold the FOR UPDATE enrollment lock). Carries the node so
       * the post-commit executor has the url/method/headers/body + node id (the
       * per-(campaign,profile,node) activity-log dedupe key).
       */
      readonly kind: 'webhook';
      readonly node: WebhookAction;
      /** The node id this webhook originates from (drives the dedupe marker). */
      readonly nodeId: string;
    };

/** The per-profile journey state the runner advances over `campaign_enrollments`. */
export interface EnrollmentState {
  readonly id: string;
  readonly workspace_id: string;
  readonly campaign_id: string;
  readonly profile_id: string;
  readonly current_node: string;
  readonly status: string;
  readonly next_run_at: Date | string | null;
  /** The CAS token (updated_at) — the optimistic-advance guard. */
  readonly updated_at: Date | string;
}

/**
 * Whether we ARRIVED at this node during the current tick (chained in from a
 * prior node) vs. the sweep PICKED UP an enrollment already parked on it. This
 * disambiguates a wait: on first arrival we set next_run_at and stay; when the
 * sweep finds a parked wait whose next_run_at has elapsed, we advance.
 */
export type Arrival = 'arrived' | 'resumed';

/** The outcome of processing a single node (pure decision). */
export type ProcessResult =
  | {
      /** Move to the next node in THIS tick (chain on). */
      readonly disposition: 'advance';
      readonly nextNode: string;
      readonly sideEffects: readonly SideEffect[];
    }
  | {
      /** Stay on this node; defer until nextRunAt (a wait boundary). */
      readonly disposition: 'stay';
      readonly nextNode: string;
      readonly nextRunAt: Date;
      readonly sideEffects: readonly SideEffect[];
    }
  | {
      /** Terminal — the enrollment completes (exit). */
      readonly disposition: 'complete';
      readonly sideEffects: readonly SideEffect[];
    };

// ── wait timing ───────────────────────────────────────────────────────────────

const ISO8601_DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Parse an ISO-8601 duration (e.g. `PT2H30M`, `P2D`) into whole seconds. Months
 * and years use nominal lengths (30d / 365d) — adequate for marketing waits.
 * THROWS on a malformed duration.
 */
export function parseIso8601DurationSeconds(iso: string): number {
  const m = ISO8601_DURATION.exec(iso);
  if (!m || iso === 'P' || iso === 'PT') {
    throw new Error(`computeWaitNextRunAt: invalid ISO-8601 duration "${iso}"`);
  }
  const [, y, mo, w, d, h, min, s] = m;
  const n = (v: string | undefined): number => (v ? parseInt(v, 10) : 0);
  return (
    n(y) * 365 * 86400 +
    n(mo) * 30 * 86400 +
    n(w) * 7 * 86400 +
    n(d) * 86400 +
    n(h) * 3600 +
    n(min) * 60 +
    n(s)
  );
}

/** A bare wall-clock `until` (no Z / no explicit ±HH:MM offset) — interpreted in ws tz. */
const BARE_WALL_CLOCK = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/;

/**
 * Compute when a wait node becomes due, from `now`:
 *   - {seconds}            → now + seconds
 *   - ISO-8601 duration    → now + parsed duration
 *   - until (date/ISO str) → that absolute instant
 * THROWS if the wait node specifies neither delay nor until.
 *
 * tz-AWARE `until`: a BARE wall-clock string (e.g. "2026-03-08T09:00", no Z / no
 * explicit offset) is interpreted in the WORKSPACE timezone via zonedInputToUtcIso
 * (DST-correct), so "9am" means 9am for the workspace. An `until` carrying an
 * explicit Z / ±HH:MM offset (or a Date) is an absolute instant, honored verbatim
 * (no double-shift). `tz` defaults to UTC for the legacy callers.
 */
export function computeWaitNextRunAt(node: WaitNode, now: Date, tz: string = DEFAULT_WORKSPACE_TZ): Date {
  if (node.until !== undefined) {
    if (typeof node.until === 'string' && BARE_WALL_CLOCK.test(node.until.trim())) {
      // Bare wall clock → interpret in the workspace tz (DST-correct).
      const iso = zonedInputToUtcIso(node.until.trim().replace(' ', 'T'), tz);
      return new Date(iso);
    }
    const at = node.until instanceof Date ? node.until : new Date(node.until);
    if (Number.isNaN(at.getTime())) {
      throw new Error('computeWaitNextRunAt: invalid until date');
    }
    return at;
  }
  if (node.delay !== undefined) {
    if (typeof node.delay === 'string') {
      const seconds = parseIso8601DurationSeconds(node.delay);
      return new Date(now.getTime() + seconds * 1000);
    }
    if (typeof node.delay.seconds === 'number' && Number.isFinite(node.delay.seconds)) {
      return new Date(now.getTime() + node.delay.seconds * 1000);
    }
    throw new Error('computeWaitNextRunAt: invalid delay');
  }
  throw new Error('computeWaitNextRunAt: wait node has neither delay nor until');
}

/** Whether a wait that is due at `nextRunAt` has elapsed as of `now`. */
export function isWaitElapsed(nextRunAt: Date | string | null, now: Date): boolean {
  if (nextRunAt === null || nextRunAt === undefined) return true;
  const at = nextRunAt instanceof Date ? nextRunAt : new Date(nextRunAt);
  if (Number.isNaN(at.getTime())) return true;
  return at.getTime() <= now.getTime();
}

// ── branch evaluation ─────────────────────────────────────────────────────────

/**
 * Build the "does THIS profile match the branch AST right now" query. Delegates
 * to @cdp/segments buildSegmentMatch so workspace_id is structurally $1 and the
 * AST is fully parameterized; restricts to the single enrolled profile via
 * `AND p.id = $profile`. Returns the profile id iff it matches. THROWS on a
 * falsy workspaceId (tenant-isolation guard).
 */
export function buildBranchMatchQuery(
  workspaceId: string,
  ast: AstNode,
  profileId: string,
): SqlStatement {
  if (!workspaceId) throw new Error('buildBranchMatchQuery: workspaceId is required');
  return buildSegmentMatch(workspaceId, ast, profileId);
}

/**
 * Decide the next node for a condition node given whether the branch matched.
 * Pure — the orchestrator runs buildBranchMatchQuery against Postgres and feeds
 * the boolean here.
 */
export function evaluateBranch(node: ConditionNode, matched: boolean): string {
  return matched ? node.onTrue : node.onFalse;
}

// ── node processing ───────────────────────────────────────────────────────────

/**
 * Process a single node into a ProcessResult (pure). `matchesNow` is the branch
 * predicate result for a condition node (the orchestrator computes it via
 * buildBranchMatchQuery); it is ignored for other node types.
 *   - trigger  → advance to next (no side effects).
 *   - wait     → if elapsed, advance to next; else stay until next_run_at.
 *   - condition→ advance to onTrue/onFalse per matchesNow.
 *   - action   → advance to next, emitting a side effect (send / set_attribute).
 *   - exit     → complete.
 */
export function processNode(
  node: Node,
  state: EnrollmentState,
  matchesNow: boolean,
  now: Date,
  arrival: Arrival = 'resumed',
  tz: string = DEFAULT_WORKSPACE_TZ,
): ProcessResult {
  switch (node.type) {
    case 'trigger':
      return { disposition: 'advance', nextNode: node.next, sideEffects: [] };

    case 'wait': {
      // Resumed by the sweep on a parked wait whose due time has elapsed → go.
      if (arrival === 'resumed' && isWaitElapsed(state.next_run_at, now)) {
        return { disposition: 'advance', nextNode: node.next, sideEffects: [] };
      }
      // First arrival at the wait this tick → compute the boundary and park (tz-aware).
      const nextRunAt = computeWaitNextRunAt(node, now, tz);
      return { disposition: 'stay', nextNode: node.next, nextRunAt, sideEffects: [] };
    }

    case 'condition': {
      const nextNode = evaluateBranch(node, matchesNow);
      return { disposition: 'advance', nextNode, sideEffects: [] };
    }

    case 'action': {
      const effect = actionSideEffect(node);
      return {
        disposition: 'advance',
        nextNode: node.next,
        sideEffects: effect ? [effect] : [],
      };
    }

    case 'hour_of_day_window': {
      // tz-aware gate (§9B): inside the allowed window (WORKSPACE tz, DST-correct)
      // → advance immediately; else PARK until the next window opening. The
      // decision is purely "is now inside?", so a RESUMED-but-still-outside parked
      // enrollment re-parks with a fresh opening (never advances early), and a
      // RESUMED-and-now-inside one advances — mirroring the wait fast-path.
      const win = {
        startHour: node.startHour,
        endHour: node.endHour,
        ...(node.daysOfWeek !== undefined ? { daysOfWeek: node.daysOfWeek } : {}),
      };
      if (isWindowOpen(now, win, tz)) {
        return { disposition: 'advance', nextNode: node.next, sideEffects: [] };
      }
      const nextRunAt = nextWindowOpening(now, win, tz);
      // nextWindowOpening only returns null when already inside (handled above);
      // fall back to advancing if it somehow can't compute an opening (never strand).
      if (nextRunAt === null) {
        return { disposition: 'advance', nextNode: node.next, sideEffects: [] };
      }
      return { disposition: 'stay', nextNode: node.next, nextRunAt, sideEffects: [] };
    }

    case 'exit':
      return { disposition: 'complete', sideEffects: [] };
  }
}

/**
 * Map an action node to its side effect (null for a missing field). The send
 * effect's nodeId is filled by the orchestrator from the enrollment's
 * current_node (the authoritative dedupe component); here it carries the empty
 * placeholder so processNode stays node-id agnostic.
 */
function actionSideEffect(node: ActionNode | WebhookAction): SideEffect | null {
  // A webhook action emits a 'webhook' side effect collected during chainTick and
  // EXECUTED AFTER THE TX COMMITS (the injected HTTP client + allowlist/SSRF guard
  // never run inside the FOR UPDATE lock). nodeId is stamped by the orchestrator
  // from the authoritative current_node (the dedupe key component).
  if (node.kind === 'webhook') {
    if (!node.url) return null;
    return { kind: 'webhook', node, nodeId: '' };
  }
  if (node.kind === 'send') {
    if (!node.template_id) return null;
    return { kind: 'send', templateId: node.template_id, nodeId: '' };
  }
  if (node.kind === 'set_attribute') {
    if (!node.key) return null;
    return { kind: 'set_attribute', key: node.key, value: node.value };
  }
  return null;
}

// ── re-enrollment ─────────────────────────────────────────────────────────────

/**
 * Decide whether a profile may (re)enroll given the policy and whether a row
 * already exists. Default policy is 'once' (the structural UNIQUE + ON CONFLICT
 * DO NOTHING is the real guard; this is the explicit decision). 'always' would
 * allow re-entry — kept for forward-compat but ON CONFLICT keeps 'once' safe
 * regardless.
 */
export function decideReenrollment(
  hasExisting: boolean,
  policy: ReenrollmentPolicy = 'once',
): boolean {
  if (policy === 'always') return true;
  return !hasExisting;
}

// ── enrollment trigger parsing ────────────────────────────────────────────────

/** A segment_change_log row shape (the bits enrollment cares about, §6). */
export interface SegmentChangeLogRow {
  readonly workspace_id: string;
  readonly segment_id: string;
  readonly profile_id: string;
  readonly action: string; // 'entered' | 'exited'
}

/** An intent to enroll a profile into a campaign (resolved from a change-log row). */
export interface EnrollmentIntent {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly profileId: string;
  readonly startNode: string;
}

/** A campaign's enrollment-relevant columns (trigger_segment_id, start node, trigger_on). */
export interface CampaignTriggerRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly trigger_segment_id: string | null;
  readonly start_node: string;
  /** Fire enrollment on segment ENTER (default) or EXIT. */
  readonly trigger_on?: 'enter' | 'exit';
}

/**
 * Parse a segment_change_log row into enrollment intents (§9B). The change-log
 * `action` is matched against each campaign's `trigger_on`: an 'entered' row
 * enrolls campaigns with trigger_on='enter' (the default), and an 'exited' row
 * enrolls campaigns with trigger_on='exit' (a profile LEAVING the segment — e.g.
 * aging out of a time window). An intent is produced per active campaign whose
 * trigger_segment_id matches the changed segment (same workspace). THROWS on a
 * falsy workspaceId.
 */
export function parseEnrollmentTrigger(
  row: SegmentChangeLogRow,
  campaigns: readonly CampaignTriggerRow[],
): EnrollmentIntent[] {
  if (!row.workspace_id) throw new Error('parseEnrollmentTrigger: workspace_id is required');
  if (row.action !== 'entered' && row.action !== 'exited') return [];
  const wantTriggerOn = row.action === 'entered' ? 'enter' : 'exit';
  const intents: EnrollmentIntent[] = [];
  for (const c of campaigns) {
    if (c.workspace_id !== row.workspace_id) continue;
    if (c.trigger_segment_id !== row.segment_id) continue;
    if ((c.trigger_on ?? 'enter') !== wantTriggerOn) continue;
    intents.push({
      workspaceId: row.workspace_id,
      campaignId: c.id,
      profileId: row.profile_id,
      startNode: c.start_node,
    });
  }
  return intents;
}

// ── SqlStatement builders (all workspace-scoped, workspace_id bound at $1) ─────

/**
 * Insert a campaign_enrollment at the start node. ON CONFLICT
 * (campaign_id, profile_id) DO NOTHING is the structural re-enrollment guard
 * ('once'): a profile already enrolled is not enrolled again. workspace_id at $1.
 */
export function buildEnrollmentInsert(
  workspaceId: string,
  campaignId: string,
  profileId: string,
  startNode: string,
): SqlStatement {
  if (!workspaceId) throw new Error('buildEnrollmentInsert: workspaceId is required');
  return {
    text: `INSERT INTO campaign_enrollments
             (workspace_id, campaign_id, profile_id, current_node, status, next_run_at)
           VALUES ($1, $2, $3, $4, 'active', now())
           ON CONFLICT (campaign_id, profile_id) DO NOTHING`,
    values: [workspaceId, campaignId, profileId, startNode],
  };
}

/** A campaign's membership-gating column (keep_while_in_segment). */
export interface CampaignKeepRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly keep_while_in_segment: string | null;
}

/** An intent to cancel (exit) a profile's active enrollment when it leaves a segment. */
export interface CancelIntent {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly profileId: string;
}

/**
 * Parse a segment_change_log row into enrollment CANCELLATIONS (§9B): for an
 * 'exited' row, every active campaign whose keep_while_in_segment matches the
 * changed segment (same workspace) yields a cancel intent for the profile — its
 * journey ends because it no longer satisfies the membership gate. Non-'exited'
 * rows yield none. THROWS on a falsy workspaceId.
 */
export function parseKeepWhileInCancellations(
  row: SegmentChangeLogRow,
  campaigns: readonly CampaignKeepRow[],
): CancelIntent[] {
  if (!row.workspace_id) throw new Error('parseKeepWhileInCancellations: workspace_id is required');
  if (row.action !== 'exited') return [];
  const out: CancelIntent[] = [];
  for (const c of campaigns) {
    if (c.workspace_id !== row.workspace_id) continue;
    if (c.keep_while_in_segment !== row.segment_id) continue;
    out.push({ workspaceId: row.workspace_id, campaignId: c.id, profileId: row.profile_id });
  }
  return out;
}

/**
 * Complete (exit) a profile's ACTIVE enrollment in a campaign — used when the
 * profile leaves a keep_while_in_segment. Only touches status='active' rows
 * (idempotent; a completed/exited enrollment is left alone). workspace_id at $1.
 */
export function buildEnrollmentCancel(
  workspaceId: string,
  campaignId: string,
  profileId: string,
): SqlStatement {
  if (!workspaceId) throw new Error('buildEnrollmentCancel: workspaceId is required');
  return {
    text: `UPDATE campaign_enrollments
              SET status = 'exited', updated_at = now()
            WHERE workspace_id = $1 AND campaign_id = $2 AND profile_id = $3 AND status = 'active'`,
    values: [workspaceId, campaignId, profileId],
  };
}

/**
 * The runner's sweep query: active enrollments whose next_run_at has arrived
 * (status='active' AND next_run_at <= now). Cross-workspace (each row carries
 * its own workspace_id, loaded by the runner — never assumed). Returns the full
 * row shape the runner needs, including updated_at (the CAS token).
 */
export function buildSweepQuery(now: Date, limit = 500): SqlStatement {
  // updated_at is read AS TEXT so the CAS token round-trips at full
  // (microsecond) precision — a JS Date only carries milliseconds and would
  // never re-match `updated_at = $n` (see buildEnrollmentClaim).
  return {
    text: `SELECT id, workspace_id, campaign_id, profile_id, current_node,
                  status, next_run_at, updated_at::text AS updated_at
           FROM campaign_enrollments
           WHERE status = 'active' AND next_run_at <= $1
           ORDER BY next_run_at ASC
           LIMIT $2`,
    values: [now.toISOString(), limit],
  };
}

/**
 * Compare-and-set CLAIM on updated_at (idempotent advance, CLAUDE.md inv.).
 * Bumps updated_at only if the row is STILL active and at the EXACT updated_at
 * the sweeper read. A concurrent sweep / retry that read the same row loses the
 * race (0 rows) and must NOT advance. workspace_id bound at $1. RETURNS the new
 * updated_at so the orchestrator can chain a guarded advance.
 */
export function buildEnrollmentClaim(
  workspaceId: string,
  enrollmentId: string,
  expectedUpdatedAt: Date | string,
): SqlStatement {
  if (!workspaceId) throw new Error('buildEnrollmentClaim: workspaceId is required');
  const ts = expectedUpdatedAt instanceof Date ? expectedUpdatedAt.toISOString() : expectedUpdatedAt;
  // The CAS compares updated_at AS TEXT against the token the sweep read (also
  // text) so the full microsecond precision matches exactly — a millisecond JS
  // Date would silently never re-match. RETURNING also casts to text so the new
  // token is carried forward at full precision for the guarded advance.
  return {
    text: `UPDATE campaign_enrollments
           SET updated_at = clock_timestamp()
           WHERE workspace_id = $1 AND id = $2 AND status = 'active'
             AND updated_at::text = $3
           RETURNING id, workspace_id, campaign_id, profile_id, current_node,
                     status, next_run_at, updated_at::text AS updated_at`,
    values: [workspaceId, enrollmentId, ts],
  };
}

/**
 * Guarded advance of an enrollment to a new node/status/next_run_at. Guarded by
 * (workspace_id, id, updated_at) so it only applies on top of the claim the
 * caller won — never double-advancing. Bumps updated_at again. workspace_id at $1.
 */
export function buildAdvanceEnrollment(
  workspaceId: string,
  enrollmentId: string,
  guardUpdatedAt: Date | string,
  next: {
    readonly currentNode: string;
    readonly status: 'active' | 'completed' | 'exited' | 'failed';
    readonly nextRunAt: Date | null;
  },
): SqlStatement {
  if (!workspaceId) throw new Error('buildAdvanceEnrollment: workspaceId is required');
  const guard = guardUpdatedAt instanceof Date ? guardUpdatedAt.toISOString() : guardUpdatedAt;
  const nextRunAt = next.nextRunAt ? next.nextRunAt.toISOString() : null;
  // Guard on updated_at AS TEXT (the claim's returned token) — same exact-match
  // reasoning as buildEnrollmentClaim.
  return {
    text: `UPDATE campaign_enrollments
           SET current_node = $4, status = $5, next_run_at = $6::timestamptz,
               updated_at = clock_timestamp()
           WHERE workspace_id = $1 AND id = $2 AND updated_at::text = $3`,
    values: [workspaceId, enrollmentId, guard, next.currentNode, next.status, nextRunAt],
  };
}

/**
 * The campaign-layer dedupe key for an action send. Stable per
 * (campaign_id, profile_id, node_id) so a retry/concurrent advance inserts the
 * outbox row AT MOST ONCE — exactly-once send (with the Dispatcher's claim).
 */
export function buildCampaignDedupeKey(
  campaignId: string,
  profileId: string,
  nodeId: string,
): string {
  return `campaign:${campaignId}:${profileId}:${nodeId}`;
}

/**
 * Insert a pending outbox row for a campaign action send. campaign_id is set
 * (so messages_log/usage attribute to the campaign). dedupe_key is the
 * campaign-layer key; ON CONFLICT (dedupe_key) DO NOTHING gives exactly-once.
 * workspace_id bound at $1.
 */
export function buildCampaignOutboxInsert(
  workspaceId: string,
  campaignId: string,
  profileId: string,
  templateId: string,
  nodeId: string,
  payload: Record<string, unknown> = {},
): SqlStatement {
  if (!workspaceId) throw new Error('buildCampaignOutboxInsert: workspaceId is required');
  const dedupeKey = buildCampaignDedupeKey(campaignId, profileId, nodeId);
  return {
    text: `INSERT INTO outbox
             (workspace_id, profile_id, campaign_id, template_id, dedupe_key, payload, status)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending')
           ON CONFLICT (dedupe_key) DO NOTHING`,
    values: [workspaceId, profileId, campaignId, templateId, dedupeKey, JSON.stringify(payload)],
  };
}

/** The recorded outcome of a webhook attempt (mirrors @cdp/runner-webhook's WebhookOutcome). */
export interface WebhookActivityOutcome {
  readonly ok: boolean;
  readonly status?: number;
  readonly attempts: number;
  readonly error?: string;
}

/**
 * Append an activity_log row recording a webhook action's outcome (§9B). The row
 * is keyed by the per-(campaign,profile,node) campaign dedupe key in `dedupe_key`;
 * ON CONFLICT (the partial unique index, migration 0036) DO NOTHING makes the
 * marker idempotent so a crash-recovery re-sweep never DOUBLE-FIRES the webhook
 * outcome. workspace_id bound at $1 (tenant-isolation guard).
 *
 * The `detail` is a short human string (status + attempts) — it NEVER contains
 * the request body or any header secret (the decrypted auth header is sent to the
 * injected client at call time only, never persisted here). `outcome` is one of
 * 'success' | 'failed' | 'blocked'.
 */
export function buildWebhookActivityInsert(
  workspaceId: string,
  profileId: string,
  campaignId: string,
  nodeId: string,
  outcome: WebhookActivityOutcome | { readonly blocked: true },
): SqlStatement {
  if (!workspaceId) throw new Error('buildWebhookActivityInsert: workspaceId is required');
  const dedupeKey = buildCampaignDedupeKey(campaignId, profileId, nodeId);
  let result: 'success' | 'failed' | 'blocked';
  let detail: string;
  if ('blocked' in outcome) {
    result = 'blocked';
    detail = 'target refused (allowlist/SSRF)';
  } else if (outcome.ok) {
    result = 'success';
    detail = `status ${outcome.status ?? '?'} (attempt ${outcome.attempts})`;
  } else {
    result = 'failed';
    const reason = outcome.error ? `error ${outcome.error}` : `status ${outcome.status ?? '?'}`;
    detail = `${reason} after ${outcome.attempts} attempt(s)`;
  }
  return {
    text: `INSERT INTO activity_log (workspace_id, profile_id, source, type, outcome, detail, dedupe_key)
           VALUES ($1, $2, 'webhook', 'webhook', $3, $4, $5)
           ON CONFLICT (workspace_id, dedupe_key) WHERE source = 'webhook' AND dedupe_key IS NOT NULL
           DO NOTHING`,
    values: [workspaceId, profileId, result, detail, dedupeKey],
  };
}

/** Set a profile attribute (the set_attribute action). workspace_id bound at $1. */
export function buildSetAttribute(
  workspaceId: string,
  profileId: string,
  key: string,
  value: unknown,
): SqlStatement {
  if (!workspaceId) throw new Error('buildSetAttribute: workspaceId is required');
  return {
    text: `UPDATE profiles
           SET attributes = jsonb_set(coalesce(attributes, '{}'::jsonb), $3::text[], $4::jsonb, true),
               updated_at = now()
           WHERE workspace_id = $1 AND id = $2`,
    values: [workspaceId, profileId, `{${key}}`, JSON.stringify(value ?? null)],
  };
}
