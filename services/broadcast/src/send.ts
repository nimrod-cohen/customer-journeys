// Broadcast orchestrator (§9A). Loads the broadcast row (workspace_id comes FROM
// the row, never the caller), guards schedule-due + a valid status transition,
// flips status→sending, RESOLVES THE AUDIENCE AT SEND TIME from
// segment_memberships (dynamic + manual), enumerates it in batches, and per
// batch: inserts outbox rows in ONE workspace-scoped tx (ON CONFLICT DO NOTHING
// → broadcast layer of exactly-once) then enqueues each `{ outbox_id }` onto the
// dispatch SQS queue. Finally flips status→sent.
//
// CRITICAL invariants enforced here:
//   - workspace_id is loaded FROM the broadcast row, never from a client.
//   - audience is resolved AT SEND TIME (memberships mutated after creation are
//     reflected) — the snapshot is the membership set as of the send.
//   - every statement binds workspace_id at $1 (runInWorkspaceTx asserts it).
//   - all sends go through the Dispatcher (we only enqueue outbox ids); we never
//     re-implement suppression/cap/quiet-hours here.
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import { resolveAudience, buildSegmentMatch, type AstNode } from '@cdp/segments';
import {
  buildBroadcastOutboxInsert,
  buildBroadcastStatusUpdate,
  buildDispatchEnqueueMessage,
  chunk,
  isScheduleDue,
  type SqlStatement,
} from './core.js';

/** A minimal query reader (returns rows). The orchestrator never opens a tx. */
export interface Reader {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/** A minimal SQS sender surface (mocked at the boundary in tests). */
export interface SqsSender {
  send(command: SendMessageCommand): Promise<unknown>;
}

/** Injected dependencies for the orchestrator — all I/O lives behind these. */
export interface BroadcastDeps {
  /** Service-role reader (bypasses RLS → in-code scoping is the guard). */
  readonly reader: Reader;
  /** The injectable SQS client (mocked in tests). */
  readonly sqs: SqsSender;
  /** Apply a list of statements in ONE workspace-scoped tx (atomic write). */
  runInWorkspaceTx(workspaceId: string, statements: readonly SqlStatement[]): Promise<void>;
  /** Injected clock for schedule-due determinism. */
  now(): Date;
  /** URL of the dispatch SQS queue (the second queue → Dispatcher, §9). */
  readonly dispatchQueueUrl: string;
  /** Recipients per outbox-insert batch (large audiences are chunked). */
  readonly batchSize?: number;
}

/** Terminal result of running one broadcast. */
export type RunBroadcastResult =
  | { readonly result: 'sent'; readonly recipientCount: number; readonly batchCount: number }
  | { readonly result: 'skipped'; readonly reason: string };

interface BroadcastRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly template_id: string | null;
  readonly audience_kind: string;
  readonly audience_ref: string;
  readonly scheduled_at: string | Date | null;
  readonly status: string;
  readonly subject: string | null;
  readonly sender_id: string | null;
}

const DEFAULT_BATCH_SIZE = 500;

/**
 * Run a single broadcast end-to-end. Idempotent + concurrency-safe: the
 * status→sending compare-and-set claims the broadcast (only the winner
 * proceeds), and the outbox INSERT is ON CONFLICT DO NOTHING. A replay after a
 * partial run re-enqueues the same outbox ids (the Dispatcher's atomic claim
 * still sends once).
 */
export async function runBroadcast(
  deps: BroadcastDeps,
  broadcastId: string,
): Promise<RunBroadcastResult> {
  // 1. Load the broadcast row. workspace_id comes FROM the row (CLAUDE.md inv.2).
  const { rows } = await deps.reader.query<BroadcastRow>(
    `SELECT id, workspace_id, template_id, audience_kind, audience_ref, scheduled_at, status, subject, sender_id
     FROM broadcasts WHERE id = $1`,
    [broadcastId],
  );
  const bc = rows[0];
  if (!bc) return { result: 'skipped', reason: 'broadcast not found' };
  const workspaceId = bc.workspace_id;
  const now = deps.now();

  // 2. Guards: terminal/illegal status, not-yet-due schedule.
  if (bc.status !== 'draft' && bc.status !== 'scheduled') {
    return { result: 'skipped', reason: `not sendable from status '${bc.status}'` };
  }
  if (!isScheduleDue(bc.scheduled_at, now)) {
    return { result: 'skipped', reason: 'not yet due' };
  }
  if (!bc.template_id) {
    return { result: 'skipped', reason: 'broadcast has no template' };
  }

  // 3. Claim: compare-and-set status→sending. If the row already moved (a
  //    concurrent run / replay won), we did not claim it → skip.
  const claim = buildBroadcastStatusUpdate(
    workspaceId,
    broadcastId,
    bc.status as 'draft' | 'scheduled',
    'sending',
  );
  await deps.runInWorkspaceTx(workspaceId, [claim]);
  const { rows: afterClaim } = await deps.reader.query<{ status: string }>(
    `SELECT status FROM broadcasts WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, broadcastId],
  );
  if (afterClaim[0]?.status !== 'sending') {
    return { result: 'skipped', reason: 'broadcast not claimed (already sending/sent)' };
  }

  // 4. Resolve the audience AT SEND TIME. A DYNAMIC segment is resolved LIVE by
  //    running its compiled rule now (so time-windowed audiences are exact and we
  //    don't depend on a materialized cache); a MANUAL list reads its curated
  //    membership rows. audience_ref is a segment_id in both cases.
  const { rows: segRows } = await deps.reader.query<{ kind: string; definition: AstNode | null }>(
    `SELECT kind, definition FROM segments WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, bc.audience_ref],
  );
  const seg = segRows[0];
  let profileIds: string[];
  if (seg && seg.kind !== 'manual') {
    // Dynamic: a null definition is an inactive draft → no audience (never blast all).
    if (!seg.definition) {
      profileIds = [];
    } else {
      const match = buildSegmentMatch(workspaceId, seg.definition);
      const { rows } = await deps.reader.query<{ id: string }>(match.text, match.values);
      profileIds = rows.map((r) => r.id);
    }
  } else {
    const aud = resolveAudience(workspaceId, bc.audience_ref);
    const { rows: members } = await deps.reader.query<{ profile_id: string }>(aud.text, aud.values);
    profileIds = members.map((m) => m.profile_id);
  }

  // The subject + chosen named sender travel in the outbox payload; the
  // Dispatcher resolves sender_id → From (the single place all sends cross, so
  // resolution lives there for broadcasts AND campaigns alike).
  const payload = {
    broadcast_id: broadcastId,
    ...(bc.subject ? { subject: bc.subject } : {}),
    ...(bc.sender_id ? { sender_id: bc.sender_id } : {}),
  };
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const batches = chunk(profileIds, batchSize);

  // 5. Per batch: insert outbox rows (one tx) → enqueue each {outbox_id}.
  for (const batch of batches) {
    const insert = buildBroadcastOutboxInsert(
      workspaceId,
      broadcastId,
      bc.template_id,
      payload,
      batch,
    );
    // RETURNING is harmless inside the tx runner, but the runner doesn't return
    // rows — so fetch the outbox ids for this batch by their dedupe keys after.
    await deps.runInWorkspaceTx(workspaceId, [insert]);

    const { rows: obRows } = await deps.reader.query<{ id: string }>(
      `SELECT id FROM outbox
       WHERE workspace_id = $1 AND dedupe_key = ANY($2::text[])`,
      [workspaceId, batch.map((p) => `broadcast:${broadcastId}:${p}`)],
    );
    for (const ob of obRows) {
      await deps.sqs.send(buildDispatchEnqueueMessage(ob.id, deps.dispatchQueueUrl));
    }
  }

  // 6. status→sent (stamps sent_at).
  await deps.runInWorkspaceTx(workspaceId, [
    buildBroadcastStatusUpdate(workspaceId, broadcastId, 'sending', 'sent'),
  ]);

  return { result: 'sent', recipientCount: profileIds.length, batchCount: batches.length };
}
