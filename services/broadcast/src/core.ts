// Broadcast pure core (§9A). No I/O — the orchestrator (send.ts) and handler
// inject readers + an SQS sender + a workspace-scoped tx runner and wire these.
// Everything here is deterministic and unit-tested without AWS or Postgres.
//
// Two pieces give the BROADCAST layer of end-to-end exactly-once (CLAUDE.md
// inv.5): a stable dedupe_key per (broadcast_id, profile_id) and a multi-row
// outbox INSERT that is ON CONFLICT (dedupe_key) DO NOTHING. A retry or a
// concurrent run therefore yields exactly one outbox row per recipient; the
// Dispatcher's atomic claim then gives exactly one SEND per row.
import { SendMessageCommand } from '@aws-sdk/client-sqs';

/** A parameterized query ready for `pool.query(text, values)` (shared shape). */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/** The broadcast lifecycle (§6 broadcasts.status). */
export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';

/**
 * The broadcast-layer dedupe key. UNIQUE per (broadcast_id, profile_id) so a
 * recipient gets at most one outbox row regardless of retries/concurrency.
 */
export function buildBroadcastDedupeKey(broadcastId: string, profileId: string): string {
  return `broadcast:${broadcastId}:${profileId}`;
}

/**
 * Build a multi-row INSERT of outbox rows for a batch of recipients (§9A).
 * workspace_id is bound at $1 (in-code scoping; service role bypasses RLS); the
 * INSERT is ON CONFLICT (dedupe_key) DO NOTHING so a replay/concurrent broadcast
 * run inserts each recipient AT MOST ONCE. The shared payload (subject/merge/
 * cap/quiet-hours) is bound once and reused for every row.
 */
export function buildBroadcastOutboxInsert(
  workspaceId: string,
  broadcastId: string,
  templateId: string | null,
  payload: Record<string, unknown>,
  profileIds: readonly string[],
): SqlStatement {
  if (!workspaceId) throw new Error('buildBroadcastOutboxInsert: workspaceId is required');
  if (profileIds.length === 0) {
    throw new Error('buildBroadcastOutboxInsert: profileIds must be non-empty');
  }
  // $1 workspace_id, $2 template_id, $3 payload, then per-profile (id, dedupe_key).
  const values: unknown[] = [workspaceId, templateId, JSON.stringify(payload)];
  const rows: string[] = [];
  for (const profileId of profileIds) {
    const pIdx = values.push(profileId); // profile_id
    const dIdx = values.push(buildBroadcastDedupeKey(broadcastId, profileId)); // dedupe_key
    rows.push(`($1, $${pIdx}, $2, $${dIdx}, $3::jsonb, 'pending')`);
  }
  return {
    text: `INSERT INTO outbox (workspace_id, profile_id, template_id, dedupe_key, payload, status)
           VALUES ${rows.join(', ')}
           ON CONFLICT (dedupe_key) DO NOTHING`,
    values,
  };
}

/** Split items into batches of at most `batchSize`, preserving order. */
export function chunk<T>(items: readonly T[], batchSize: number): T[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('chunk: batchSize must be a positive integer');
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(items.slice(i, i + batchSize));
  }
  return out;
}

/** Legal broadcast state transitions (§6). `sending` may roll BACK to draft/
 *  scheduled when a send fails after the claim (so it's never stuck 'sending'). */
const TRANSITIONS: Readonly<Record<BroadcastStatus, readonly BroadcastStatus[]>> = {
  draft: ['scheduled', 'sending', 'cancelled'],
  scheduled: ['sending', 'cancelled'],
  sending: ['sent', 'draft', 'scheduled'],
  sent: [],
  cancelled: [],
};

/** Whether `from`→`to` is a legal broadcast transition. */
export function isValidBroadcastTransition(from: string, to: string): boolean {
  const allowed = TRANSITIONS[from as BroadcastStatus];
  return allowed !== undefined && allowed.includes(to as BroadcastStatus);
}

/**
 * Build a compare-and-set status update (§9A). Atomic guard: the row only flips
 * if it is STILL in the `from` status (WHERE status = from) within the
 * workspace. On →sent it stamps sent_at. workspace_id bound at $1. Throws on an
 * illegal transition so an invalid state change never reaches the DB.
 */
export function buildBroadcastStatusUpdate(
  workspaceId: string,
  broadcastId: string,
  from: BroadcastStatus,
  to: BroadcastStatus,
): SqlStatement {
  if (!workspaceId) throw new Error('buildBroadcastStatusUpdate: workspaceId is required');
  if (!isValidBroadcastTransition(from, to)) {
    throw new Error(`buildBroadcastStatusUpdate: illegal transition ${from} -> ${to}`);
  }
  const setSentAt = to === 'sent' ? ', sent_at = now()' : '';
  return {
    text: `UPDATE broadcasts SET status = $4${setSentAt}
           WHERE workspace_id = $1 AND id = $2 AND status = $3`,
    values: [workspaceId, broadcastId, from, to],
  };
}

/** A scheduled_at value as stored/loaded (timestamptz). */
type ScheduledAt = Date | string | null;

/** Whether a broadcast is due to send now (null scheduled_at = send-now). */
export function isScheduleDue(scheduledAt: ScheduledAt, now: Date): boolean {
  if (scheduledAt === null || scheduledAt === undefined) return true;
  const at = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  return at.getTime() <= now.getTime();
}

/** Select scheduled broadcasts whose scheduled_at has arrived (sweep query). */
export function buildDueScheduledBroadcastsQuery(now: Date): SqlStatement {
  return {
    text: `SELECT id, workspace_id
           FROM broadcasts
           WHERE status = 'scheduled' AND scheduled_at <= $1`,
    values: [now],
  };
}

/**
 * Build the SQS message that enqueues an outbox id onto the DISPATCH queue. The
 * body is `{ outbox_id }` ONLY — the workspace_id is NEVER carried (CLAUDE.md
 * inv.2; the Dispatcher loads it from the outbox row). Matches the dispatcher's
 * parseOutboxIdFromSqsRecord contract.
 */
export function buildDispatchEnqueueMessage(outboxId: string, queueUrl: string): SendMessageCommand {
  return new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ outbox_id: outboxId }),
  });
}
