// Feedback orchestrator (§10). Resolves the workspace SENDER-SIDE (tag →
// config_set → from-domain via the reader), resolves the affected profile by
// (workspace_id, email), builds + commits the feedback plan in ONE
// workspace-scoped tx, then runs reputation policing for that workspace and
// auto-suspends it (and ONLY it) when decideReputation says so.
//
// CRITICAL invariants enforced here:
//   - An UNRESOLVED workspace → status 'unresolved' (the handler turns that into
//     a batch item failure). NEVER a guessed/default workspace.
//   - Suppression is per-workspace; the global hard-bounce row is the only
//     cross-workspace write (and only for hard bounces).
//   - Idempotency lives in the SqlStatements (ON CONFLICT DO NOTHING on the
//     idempotency index / PKs) — a replayed SNS notification is a no-op.
//   - Auto-suspend targets ONLY the offending workspace id.
import {
  classifySesEvent,
  resolveWorkspaceRef,
  shouldMarkPermanentSoftBounce,
  PERMANENT_SOFT_BOUNCE,
  decideReputation,
  buildEmailEventInsert,
  buildSuppressionUpsert,
  buildGlobalHardBounceUpsert,
  buildProfileEmailStatusUpdate,
  buildMessagesLogMarkFailed,
  buildSoftBounceDayCountQuery,
  buildReputationRateQuery,
  buildWorkspaceSuspend,
  type ClassifiedEvent,
  type SesNotification,
  type SqlStatement,
  type WorkspaceRef,
} from './core.js';

/** A minimal query reader (returns rows). The orchestrator never opens a tx. */
export interface Reader {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Injected dependencies for the orchestrator — all I/O lives behind these. */
export interface FeedbackDeps {
  /** Service-role reader (bypasses RLS → in-code scoping is the guard). */
  readonly reader: Reader;
  /** Apply a list of statements in ONE workspace-scoped tx (atomic write). */
  runInWorkspaceTx(workspaceId: string, statements: readonly SqlStatement[]): Promise<void>;
}

/** The terminal result of handling one notification. */
export type FeedbackResult =
  | { readonly status: 'ok'; readonly workspaceId: string; readonly suspended: boolean }
  | { readonly status: 'unresolved'; readonly reason: string }
  | { readonly status: 'noop'; readonly reason: string };

// ── plan builder (pure) ───────────────────────────────────────────────────────

/** Inputs for building the per-notification write plan. */
export interface FeedbackPlanInput {
  readonly workspaceId: string;
  readonly classified: ClassifiedEvent;
  /** Resolved profile id for the affected recipient (null if unknown). */
  readonly profileId: string | null;
  /** Distinct UTC days the recipient has soft-bounced on since the last delivery
   * (INCLUDING today's bounce) — drives the permanent_soft_bounce decision. */
  readonly softBounceDistinctDays: number;
  /** The raw notification for storage in email_events.raw. */
  readonly raw: unknown;
}

/**
 * Build the ordered list of SqlStatements for one classified notification:
 *   - ALWAYS an email_events insert (idempotent on (ws, ses_message_id, type)).
 *   - hard_bounce → per-workspace suppression + global_hard_bounces + profile
 *     status 'bounced'.
 *   - complaint   → per-workspace suppression + profile status 'complained'
 *     (NO global row — a complaint is sender-relative).
 *   - soft_bounce → suppression ONLY when this event crosses the threshold N.
 *   - other       → just the event row.
 * The recipient email is carried in email_events.raw->>'recipient' so the
 * soft-bounce count query can find it. Pure — no I/O.
 */
export function buildFeedbackPlan(input: FeedbackPlanInput): SqlStatement[] {
  const { workspaceId, classified, profileId } = input;
  const email = classified.recipients[0] ?? null;

  // The raw we store carries the (already lowercased) recipient so the
  // soft-bounce count query can match by raw->>'recipient'.
  const rawForStore =
    typeof input.raw === 'object' && input.raw !== null
      ? { ...(input.raw as Record<string, unknown>), recipient: email }
      : { recipient: email };

  const plan: SqlStatement[] = [
    buildEmailEventInsert(workspaceId, {
      sesMessageId: classified.sesMessageId,
      type: classified.type,
      subType: classified.subType,
      profileId,
      raw: rawForStore,
    }),
  ];

  if (!email) return plan;

  // A bounced/complained message is NEVER retried — just mark THAT send failed.
  const markFailed = (status: string): void => {
    if (classified.sesMessageId) {
      plan.push(buildMessagesLogMarkFailed(workspaceId, classified.sesMessageId, status));
    }
  };

  if (classified.category === 'hard_bounce') {
    plan.push(buildSuppressionUpsert(workspaceId, email, 'hard_bounce', 'feedback'));
    plan.push(buildGlobalHardBounceUpsert(email));
    plan.push(buildProfileEmailStatusUpdate(workspaceId, email, 'bounced'));
    markFailed('bounced');
  } else if (classified.category === 'complaint') {
    plan.push(buildSuppressionUpsert(workspaceId, email, 'complaint', 'feedback'));
    plan.push(buildProfileEmailStatusUpdate(workspaceId, email, 'complained'));
    markFailed('complained');
  } else if (classified.category === 'soft_bounce') {
    // Every soft bounce marks its own message failed (no retry). Once the address
    // has soft-bounced on N distinct days (no delivery in between) it becomes
    // PERMANENT: an explicit suppression (reason permanent_soft_bounce) + the
    // profile's email_status flips to permanent_soft_bounce (no longer active).
    markFailed('bounced');
    if (shouldMarkPermanentSoftBounce(input.softBounceDistinctDays)) {
      plan.push(buildSuppressionUpsert(workspaceId, email, PERMANENT_SOFT_BOUNCE, 'feedback'));
      plan.push(buildProfileEmailStatusUpdate(workspaceId, email, PERMANENT_SOFT_BOUNCE));
    }
  }

  return plan;
}

// ── workspace resolution (sender-side, via the reader) ────────────────────────

/**
 * Turn a sender-side WorkspaceRef into a concrete workspace id by reading the
 * workspaces table. A 'tag' ref is already a concrete id (verified to exist); a
 * 'config_set'/'from_domain' ref is looked up in sending_identity. Returns null
 * if no workspace matches — the caller then reports an UNRESOLVED event (never a
 * guessed/default workspace).
 */
async function resolveWorkspaceId(deps: FeedbackDeps, ref: WorkspaceRef): Promise<string | null> {
  if (ref.by === 'tag') {
    const { rows } = await deps.reader.query<{ id: string }>(
      `SELECT id FROM workspaces WHERE id = $1`,
      [ref.workspaceId],
    );
    return rows[0]?.id ?? null;
  }
  if (ref.by === 'config_set') {
    const { rows } = await deps.reader.query<{ id: string }>(
      `SELECT id FROM workspaces WHERE sending_identity->>'config_set' = $1`,
      [ref.configSet],
    );
    return rows[0]?.id ?? null;
  }
  // from_domain
  const { rows } = await deps.reader.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE sending_identity->>'from_domain' = $1`,
    [ref.fromDomain],
  );
  return rows[0]?.id ?? null;
}

// ── handleNotification (orchestration) ────────────────────────────────────────

/**
 * Handle one parsed SES notification end-to-end. Resolves the workspace
 * sender-side, resolves the profile, builds + commits the plan, then runs
 * reputation policing (auto-suspending ONLY the offending workspace). Returns a
 * FeedbackResult the handler maps to ack / batch-failure.
 */
export async function handleNotification(
  deps: FeedbackDeps,
  notification: SesNotification,
): Promise<FeedbackResult> {
  const ref = resolveWorkspaceRef(notification);
  if (!ref) {
    return { status: 'unresolved', reason: 'no sender-side workspace signal' };
  }
  const workspaceId = await resolveWorkspaceId(deps, ref);
  if (!workspaceId) {
    return { status: 'unresolved', reason: `workspace not found for ${ref.by}` };
  }

  const classified = classifySesEvent(notification);
  const email = classified.recipients[0] ?? null;

  // Resolve the affected profile by (workspace_id, email) — scoped in code.
  let profileId: string | null = null;
  if (email) {
    const { rows } = await deps.reader.query<{ id: string }>(
      `SELECT id FROM profiles WHERE workspace_id = $1 AND email = $2`,
      [workspaceId, email],
    );
    profileId = rows[0]?.id ?? null;
  }

  // For a soft bounce, count the distinct UTC days it has bounced on since the
  // last delivery (including today) — drives the permanent decision (replay-safe).
  let softBounceDistinctDays = 0;
  if (classified.category === 'soft_bounce' && email) {
    const q = buildSoftBounceDayCountQuery(workspaceId, email);
    const { rows } = await deps.reader.query<{ n: number }>(q.text, q.values);
    softBounceDistinctDays = rows[0]?.n ?? 0;
  }

  const plan = buildFeedbackPlan({
    workspaceId,
    classified,
    profileId,
    softBounceDistinctDays,
    raw: notification,
  });

  await deps.runInWorkspaceTx(workspaceId, plan);

  // Reputation policing — per-workspace rate, auto-suspend ONLY this workspace.
  const suspended = await policeReputation(deps, workspaceId);

  return { status: 'ok', workspaceId, suspended };
}

/**
 * Compute this workspace's per-workspace bounce/complaint rates and suspend it
 * (and ONLY it) when decideReputation says so. The suspend write is itself
 * workspace-scoped (WHERE id = $1). Returns whether a suspend was issued.
 */
async function policeReputation(deps: FeedbackDeps, workspaceId: string): Promise<boolean> {
  const q = buildReputationRateQuery(workspaceId);
  const { rows } = await deps.reader.query<{ sent: number; bounces: number; complaints: number }>(
    q.text,
    q.values,
  );
  const counts = rows[0] ?? { sent: 0, bounces: 0, complaints: 0 };
  const decision = decideReputation({
    sent: Number(counts.sent),
    bounces: Number(counts.bounces),
    complaints: Number(counts.complaints),
  });
  if (!decision.suspend) return false;
  await deps.runInWorkspaceTx(workspaceId, [buildWorkspaceSuspend(workspaceId)]);
  return true;
}
