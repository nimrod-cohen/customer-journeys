// Feedback Lambda pure core (§10). No I/O — the orchestrator (feedback.ts) and
// the handler inject readers + a workspace-scoped tx runner and wire these.
// Everything here is deterministic and unit-tested without AWS or Postgres.
//
// Two security-critical properties live here:
//   1. WORKSPACE RESOLUTION IS SENDER-SIDE ONLY (resolveWorkspaceRef): the
//      workspace is derived from our own sender-set signals (mail.tags →
//      configuration set → from-domain). It is NEVER read from the recipient or
//      any client-supplied field. An unresolved event must become a batch
//      failure upstream, never a guessed/default workspace.
//   2. Every SqlStatement builder is workspace-scoped (workspace_id bound at $1)
//      and throws on a falsy workspaceId — the in-code tenancy guard (the
//      Feedback Lambda runs as the service role and bypasses RLS). The lone
//      exception is global_hard_bounces, which is cross-workspace BY DESIGN.

/** A parameterized query ready for `pool.query(text, values)` (shared shape). */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

// ── classify ─────────────────────────────────────────────────────────────────

/** Our internal categorization of an SES feedback notification. */
export type FeedbackCategory = 'hard_bounce' | 'soft_bounce' | 'complaint' | 'other';

/** The raw email_events.type label we store (delivery|bounce|complaint|open|click). */
export type EmailEventType = 'delivery' | 'bounce' | 'complaint' | 'open' | 'click' | 'other';

/** The result of classifying one SES notification. */
export interface ClassifiedEvent {
  /** Internal decisioning category. */
  readonly category: FeedbackCategory;
  /** The email_events.type label for storage. */
  readonly type: EmailEventType;
  /** The bounce/complaint sub-type (e.g. 'Permanent'/'Transient'), if any. */
  readonly subType: string | null;
  /** The SES message id (mail.messageId) — the idempotency key component. */
  readonly sesMessageId: string | null;
  /** Affected recipients, lowercased. */
  readonly recipients: string[];
}

/** Loose SES notification shape (legacy SNS OR Configuration-Set publishing). */
export interface SesNotification {
  readonly notificationType?: string;
  readonly eventType?: string;
  readonly configurationSetName?: string;
  readonly mail?: {
    readonly messageId?: string;
    readonly source?: string;
    readonly sourceDomain?: string;
    readonly from?: string;
    readonly destination?: string[];
    readonly tags?: Record<string, string | string[]>;
  };
  readonly bounce?: {
    readonly bounceType?: string;
    readonly bouncedRecipients?: { emailAddress?: string }[];
  };
  readonly complaint?: {
    readonly complainedRecipients?: { emailAddress?: string }[];
  };
}

function lc(s: string | undefined | null): string {
  return (s ?? '').trim().toLowerCase();
}

/** The notification "kind" from either shape (legacy notificationType OR eventType). */
function notificationKind(n: SesNotification): string {
  return (n.notificationType ?? n.eventType ?? '').trim();
}

/**
 * Classify an SES notification. Reads BOTH the legacy SNS `notificationType`
 * and the Configuration-Set `eventType`. Recipients are lowercased; the SES
 * message id is `mail.messageId`.
 */
export function classifySesEvent(n: SesNotification): ClassifiedEvent {
  const kind = notificationKind(n).toLowerCase();
  const sesMessageId = n.mail?.messageId ?? null;

  let category: FeedbackCategory = 'other';
  let type: EmailEventType = 'other';
  let subType: string | null = null;
  let recipients: string[] = [];

  if (kind === 'bounce') {
    type = 'bounce';
    subType = n.bounce?.bounceType ?? null;
    category = subType === 'Permanent' ? 'hard_bounce' : 'soft_bounce';
    recipients = (n.bounce?.bouncedRecipients ?? [])
      .map((r) => lc(r.emailAddress))
      .filter(Boolean);
  } else if (kind === 'complaint') {
    type = 'complaint';
    category = 'complaint';
    recipients = (n.complaint?.complainedRecipients ?? [])
      .map((r) => lc(r.emailAddress))
      .filter(Boolean);
  } else if (kind === 'delivery') {
    type = 'delivery';
    category = 'other';
  } else if (kind === 'open') {
    type = 'open';
    category = 'other';
  } else if (kind === 'click') {
    type = 'click';
    category = 'other';
  }

  // Fallback to the destination list when no bounce/complaint recipient list.
  if (recipients.length === 0 && n.mail?.destination) {
    recipients = n.mail.destination.map((d) => lc(d)).filter(Boolean);
  }

  return { category, type, subType, sesMessageId, recipients };
}

// ── resolveWorkspaceRef (SENDER-SIDE ONLY) ────────────────────────────────────

/** How a workspace was (or wasn't) resolved from a notification — sender-side only. */
export type WorkspaceRef =
  | { readonly by: 'tag'; readonly workspaceId: string }
  | { readonly by: 'config_set'; readonly configSet: string }
  | { readonly by: 'from_domain'; readonly fromDomain: string };

function firstTagValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v.find((x) => typeof x === 'string' && x.length > 0);
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function extractFromDomain(n: SesNotification): string | undefined {
  const mail = n.mail;
  if (!mail) return undefined;
  if (mail.sourceDomain) return lc(mail.sourceDomain);
  const src = mail.source ?? mail.from;
  if (!src) return undefined;
  const at = src.lastIndexOf('@');
  if (at === -1) return undefined;
  const domain = lc(src.slice(at + 1));
  return domain || undefined;
}

/**
 * Resolve a workspace REFERENCE from SENDER-SIDE signals ONLY, in priority:
 *   1. mail.tags.workspace_id (set by our own sender)
 *   2. configuration set name (mail.tags['ses:configuration-set'] /
 *      mail.tags.configurationSet, or top-level configurationSetName)
 *   3. the from-domain (mail.source / mail.from / mail.sourceDomain)
 * Returns null when no sender-side signal exists — the orchestrator turns that
 * into a batch failure (NEVER a guessed/default workspace). Recipient and any
 * client-supplied field are intentionally ignored.
 */
export function resolveWorkspaceRef(n: SesNotification): WorkspaceRef | null {
  const tags = n.mail?.tags ?? {};

  // 1. explicit workspace_id tag.
  const wsTag = firstTagValue(tags['workspace_id']);
  if (wsTag) return { by: 'tag', workspaceId: wsTag };

  // 2. configuration set name (tag variants then top-level).
  const cfg =
    firstTagValue(tags['ses:configuration-set']) ??
    firstTagValue(tags['configurationSet']) ??
    firstTagValue(tags['configuration_set']) ??
    (typeof n.configurationSetName === 'string' && n.configurationSetName.length > 0
      ? n.configurationSetName
      : undefined);
  if (cfg) return { by: 'config_set', configSet: cfg };

  // 3. from-domain (sender identity).
  const fromDomain = extractFromDomain(n);
  if (fromDomain) return { by: 'from_domain', fromDomain };

  return null;
}

// ── soft-bounce threshold ─────────────────────────────────────────────────────

/** Number of DISTINCT soft bounces after which an address is suppressed (§10). */
export const SOFT_BOUNCE_THRESHOLD_N = 3;

/**
 * Whether the CURRENT soft bounce crosses the suppression threshold, given the
 * count of PRIOR distinct soft-bounce events for the address. The current event
 * is the `(priorCount + 1)`-th, so it suppresses once `priorCount + 1 >= N`.
 */
export function shouldSuppressSoftBounce(priorCount: number, n: number = SOFT_BOUNCE_THRESHOLD_N): boolean {
  return priorCount + 1 >= n;
}

// ── reputation decision ───────────────────────────────────────────────────────

/** Critical per-workspace bounce rate (SES pauses the account ~10%; §10). */
export const BOUNCE_RATE_CRITICAL = 0.05;
/** Critical per-workspace complaint rate (SES pauses ~0.5%; §10). */
export const COMPLAINT_RATE_CRITICAL = 0.001;
/** Minimum sends before a rate is trustworthy enough to act on (guard). */
export const MIN_SENT_FOR_RATE = 50;

/** The per-workspace reputation counters the decision reads. */
export interface ReputationCounts {
  readonly sent: number;
  readonly bounces: number;
  readonly complaints: number;
}

/** The reputation policing decision (auto-suspend the offending workspace). */
export interface ReputationDecision {
  readonly suspend: boolean;
  readonly reason: string;
  readonly bounceRate: number;
  readonly complaintRate: number;
}

/**
 * Decide whether a workspace should be auto-suspended on its OWN per-workspace
 * bounce/complaint rates. Below MIN_SENT_FOR_RATE the denominator is too small
 * to trust → never suspend. Otherwise suspend when either rate breaches its
 * critical threshold. Pure: the offending workspace is isolated by the caller.
 */
export function decideReputation(counts: ReputationCounts): ReputationDecision {
  const sent = counts.sent;
  const bounceRate = sent > 0 ? counts.bounces / sent : 0;
  const complaintRate = sent > 0 ? counts.complaints / sent : 0;

  if (sent < MIN_SENT_FOR_RATE) {
    return {
      suspend: false,
      reason: `insufficient volume (sent ${sent} < min ${MIN_SENT_FOR_RATE})`,
      bounceRate,
      complaintRate,
    };
  }
  if (bounceRate >= BOUNCE_RATE_CRITICAL) {
    return {
      suspend: true,
      reason: `bounce rate ${bounceRate.toFixed(4)} >= ${BOUNCE_RATE_CRITICAL}`,
      bounceRate,
      complaintRate,
    };
  }
  if (complaintRate >= COMPLAINT_RATE_CRITICAL) {
    return {
      suspend: true,
      reason: `complaint rate ${complaintRate.toFixed(4)} >= ${COMPLAINT_RATE_CRITICAL}`,
      bounceRate,
      complaintRate,
    };
  }
  return { suspend: false, reason: 'within thresholds', bounceRate, complaintRate };
}

// ── SqlStatement builders (workspace-scoped, workspace_id at $1) ───────────────

/** The data for one email_events row (idempotent on (ws, ses_message_id, type)). */
export interface EmailEventRow {
  readonly sesMessageId: string | null;
  readonly type: string;
  readonly subType: string | null;
  readonly profileId: string | null;
  readonly raw: unknown;
}

/**
 * Insert one email_events row, idempotent on the Phase-8 idempotency index
 * (workspace_id, ses_message_id, type) via ON CONFLICT DO NOTHING. A replayed
 * SNS notification is a no-op — exactly one row, and a soft-bounce count never
 * advances on a replay. workspace_id bound at $1.
 */
export function buildEmailEventInsert(workspaceId: string, row: EmailEventRow): SqlStatement {
  if (!workspaceId) throw new Error('buildEmailEventInsert: workspaceId is required');
  return {
    text: `INSERT INTO email_events (workspace_id, ses_message_id, profile_id, type, sub_type, raw)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (workspace_id, ses_message_id, type) DO NOTHING`,
    values: [
      workspaceId,
      row.sesMessageId,
      row.profileId,
      row.type,
      row.subType,
      row.raw === undefined ? null : JSON.stringify(row.raw),
    ],
  };
}

/**
 * Upsert a per-workspace suppression (hard_bounce|complaint|unsubscribe|manual).
 * ON CONFLICT (workspace_id, email) DO NOTHING keeps the FIRST reason and makes
 * replays idempotent. PER-WORKSPACE: A's suppression never blocks B.
 * workspace_id bound at $1.
 */
export function buildSuppressionUpsert(
  workspaceId: string,
  email: string,
  reason: string,
  source: string | null = null,
): SqlStatement {
  if (!workspaceId) throw new Error('buildSuppressionUpsert: workspaceId is required');
  return {
    text: `INSERT INTO suppressions (workspace_id, email, reason, source)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (workspace_id, email) DO NOTHING`,
    values: [workspaceId, email, reason, source],
  };
}

/**
 * Add an address to the CROSS-WORKSPACE global_hard_bounces list (invalid
 * mailbox → blocked everywhere via the dispatcher's buildIsSuppressedQuery
 * global arm). This is the deliberate cross-workspace exception (§10), so there
 * is NO workspace_id. ON CONFLICT (email) DO NOTHING → idempotent.
 */
export function buildGlobalHardBounceUpsert(email: string): SqlStatement {
  if (!email) throw new Error('buildGlobalHardBounceUpsert: email is required');
  return {
    text: `INSERT INTO global_hard_bounces (email)
           VALUES ($1)
           ON CONFLICT (email) DO NOTHING`,
    values: [email],
  };
}

/**
 * Update the profile's email_status (bounced|complained) for the bounced/
 * complained address, scoped by (workspace_id, email). workspace_id bound at $1.
 */
export function buildProfileEmailStatusUpdate(
  workspaceId: string,
  email: string,
  status: string,
): SqlStatement {
  if (!workspaceId) throw new Error('buildProfileEmailStatusUpdate: workspaceId is required');
  return {
    text: `UPDATE profiles
           SET email_status = $3, updated_at = now()
           WHERE workspace_id = $1 AND email = $2`,
    values: [workspaceId, email, status],
  };
}

/**
 * Count PRIOR distinct soft bounces for an address in this workspace (from
 * email_events: type='bounce', sub_type='Transient'). The DISTINCT key is the
 * SES message id, so a replayed ses_message_id does NOT inflate the count.
 * workspace_id bound at $1.
 */
export function buildSoftBounceCountQuery(workspaceId: string, email: string): SqlStatement {
  if (!workspaceId) throw new Error('buildSoftBounceCountQuery: workspaceId is required');
  return {
    text: `SELECT count(DISTINCT ses_message_id)::int AS n
           FROM email_events
           WHERE workspace_id = $1
             AND type = 'bounce'
             AND sub_type = 'Transient'
             AND raw->>'recipient' = $2`,
    values: [workspaceId, email],
  };
}

/**
 * Per-workspace reputation rates: bounce/complaint counts from email_events
 * (numerator) over sends from messages_log (denominator), workspace-scoped.
 * Returns one row { sent, bounces, complaints }. workspace_id bound at $1 (reused
 * for both arms). Both sub-selects scope by workspace_id (service role bypasses
 * RLS → in-code scoping is the guard).
 */
export function buildReputationRateQuery(workspaceId: string): SqlStatement {
  if (!workspaceId) throw new Error('buildReputationRateQuery: workspaceId is required');
  return {
    text: `SELECT
             (SELECT count(*)::int FROM messages_log WHERE workspace_id = $1) AS sent,
             (SELECT count(*)::int FROM email_events
                WHERE workspace_id = $1 AND type = 'bounce') AS bounces,
             (SELECT count(*)::int FROM email_events
                WHERE workspace_id = $1 AND type = 'complaint') AS complaints`,
    values: [workspaceId],
  };
}

/**
 * Suspend ONLY the offending workspace (status='suspended'). Bound to a single
 * id at $1 so a healthy workspace is never touched (§10 reputation isolation).
 */
export function buildWorkspaceSuspend(workspaceId: string): SqlStatement {
  if (!workspaceId) throw new Error('buildWorkspaceSuspend: workspaceId is required');
  return {
    text: `UPDATE workspaces SET status = 'suspended' WHERE id = $1`,
    values: [workspaceId],
  };
}
