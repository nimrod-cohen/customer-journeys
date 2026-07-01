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
import {
  resolveAudience,
  buildSegmentMatch,
  collectAudienceSegmentIds,
  inlineDynamicSegments,
  type AstNode,
  type AudienceSegmentDef,
} from '@cdp/segments';
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
  readonly audience_kind: string | null;
  readonly audience_ref: string | null;
  /** The comprehensive audience RULE (§8 AST). When set it supersedes audience_ref. */
  readonly audience: AstNode | null;
  readonly scheduled_at: string | Date | null;
  readonly status: string;
  /** The sending channel (email default; sms/whatsapp for text broadcasts). */
  readonly medium: string;
  /** The SMS/WhatsApp body (null for email, which uses its template instance). */
  readonly text_body: string | null;
  /** WhatsApp approved-template selection ({name, language, params}) or null. */
  readonly whatsapp_template: unknown;
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
    `SELECT id, workspace_id, template_id, audience_kind, audience_ref, audience, scheduled_at, status, medium, text_body, whatsapp_template
     FROM broadcasts WHERE id = $1`,
    [broadcastId],
  );
  const bc = rows[0];
  if (!bc) return { result: 'skipped', reason: 'broadcast not found' };
  const workspaceId = bc.workspace_id;
  const now = deps.now();
  const medium = bc.medium === 'sms' || bc.medium === 'whatsapp' ? bc.medium : 'email';
  const isText = medium !== 'email';

  // 2. Guards: terminal/illegal status, not-yet-due schedule.
  if (bc.status !== 'draft' && bc.status !== 'scheduled') {
    return { result: 'skipped', reason: `not sendable from status '${bc.status}'` };
  }
  if (!isScheduleDue(bc.scheduled_at, now)) {
    return { result: 'skipped', reason: 'not yet due' };
  }
  // EMAIL needs its template instance (the body + envelope). TEXT channels need a
  // non-blank text_body instead (no template). The outbox carries the template_id
  // for email and null for text; the Dispatcher reads text_body from the row.
  if (!isText && !bc.template_id) {
    return { result: 'skipped', reason: 'broadcast has no template' };
  }
  // WhatsApp may send an approved TEMPLATE instead of a text body (the dispatcher reads
  // whatsapp_template from the row); SMS still requires a non-blank body.
  const hasBody = !!bc.text_body && bc.text_body.trim() !== '';
  const hasWaTemplate =
    medium === 'whatsapp' &&
    typeof bc.whatsapp_template === 'object' &&
    bc.whatsapp_template !== null &&
    typeof (bc.whatsapp_template as { name?: unknown }).name === 'string';
  if (isText && !hasBody && !hasWaTemplate) {
    return { result: 'skipped', reason: 'broadcast has no message body' };
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

  // Everything after the claim runs under a guard: if ANY step throws — most
  // notably the audience segment's rule failing to compile — revert status
  // sending→<original> so the broadcast is never left stuck permanently
  // 'sending' (uneditable AND unsendable). Then re-throw so the caller surfaces
  // the real error.
  try {
    // 4. Resolve the audience AT SEND TIME.
    let profileIds: string[];
    if (bc.audience) {
      // COMPREHENSIVE RULE (§9A): a segment-style AST mixing attribute/event conditions
      // with segment-membership leaves (include/exclude) under AND/OR. Resolved LIVE:
      // DYNAMIC referenced segments are inlined to their rule (so include/exclude reflect
      // who matches NOW), MANUAL ones stay membership lookups. compileWhere prepends
      // workspace_id = $1 (inv. 6), so this inherits tenant isolation.
      const segIds = collectAudienceSegmentIds(bc.audience);
      const defs = new Map<string, AudienceSegmentDef>();
      if (segIds.length > 0) {
        const { rows: defRows } = await deps.reader.query<{ id: string; kind: string; definition: AstNode | null }>(
          `SELECT id, kind, definition FROM segments WHERE workspace_id = $1 AND id = ANY($2)`,
          [workspaceId, segIds],
        );
        for (const r of defRows) defs.set(r.id, { kind: r.kind, definition: r.definition });
      }
      const match = buildSegmentMatch(workspaceId, inlineDynamicSegments(bc.audience, defs));
      const { rows: matchRows } = await deps.reader.query<{ id: string }>(match.text, match.values);
      profileIds = matchRows.map((r) => r.id);
    } else if (bc.audience_ref) {
      // LEGACY single-segment pointer (back-compat). A DYNAMIC segment is resolved LIVE
      // by running its compiled rule now; a MANUAL list reads its curated membership rows.
      const { rows: segRows } = await deps.reader.query<{ kind: string; definition: AstNode | null }>(
        `SELECT kind, definition FROM segments WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, bc.audience_ref],
      );
      const seg = segRows[0];
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
    } else {
      // No audience configured at all → send to nobody (never blast-all).
      profileIds = [];
    }

    // The envelope (subject / From / To) lives on the email instance (template),
    // resolved by the Dispatcher at send. The payload carries attribution + the
    // MEDIUM so the Dispatcher routes the send (email → SES; sms/whatsapp → the
    // channel provider, reading text_body from the broadcast row).
    const payload = { broadcast_id: broadcastId, medium };
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
  } catch (err) {
    // Revert the claim so the broadcast returns to its pre-send state (best effort;
    // never mask the original error).
    await deps
      .runInWorkspaceTx(workspaceId, [
        buildBroadcastStatusUpdate(workspaceId, broadcastId, 'sending', bc.status as 'draft' | 'scheduled'),
      ])
      .catch(() => {});
    throw err;
  }
}
