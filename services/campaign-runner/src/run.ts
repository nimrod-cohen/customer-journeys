// Campaign-runner per-enrollment orchestrator (§9B). Given a swept enrollment
// row, it:
//   1. CLAIMS the row via CAS on updated_at (idempotent advance — a concurrent
//      sweep/retry that read the same updated_at loses and does NOT advance).
//   2. Processes node(s) in ONE tick: chains through trigger/condition/action
//      nodes until it hits a WAIT boundary or an EXIT (with a MAX_STEPS_PER_TICK
//      loop guard so a pathological graph can't spin forever).
//   3. Enqueues action sends through the Dispatcher (outbox row with a
//      node-scoped dedupe_key → {outbox_id} on the dispatch queue) and applies
//      set_attribute writes — together with the guarded advance in ONE tx.
//   4. ADVANCES the enrollment (current_node/status/next_run_at) guarded by the
//      claim's updated_at, so the whole tick is atomic + at-most-once.
//
// workspace_id is loaded FROM the enrollment row (never assumed). All sends flow
// through the real Dispatcher — this module only inserts outbox + enqueues ids.
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  processNode,
  buildEnrollmentClaim,
  buildAdvanceEnrollment,
  buildBranchMatchQuery,
  buildCampaignOutboxInsert,
  buildCampaignDedupeKey,
  buildSetAttribute,
  type EnrollmentState,
  type SideEffect,
  type SqlStatement,
  type ProcessResult,
  type Arrival,
} from './core.js';
import {
  validateCampaignDefinition,
  findNode,
  type CampaignDefinition,
  type Node,
} from './dsl.js';

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

/** Injected dependencies for the runner. */
export interface RunDeps {
  /** Service-role reader (bypasses RLS → in-code scoping is the guard). */
  readonly reader: Reader;
  /** The injectable SQS client (mocked in tests). */
  readonly sqs: SqsSender;
  /** Apply a list of statements in ONE workspace-scoped tx (atomic write). */
  runInWorkspaceTx(workspaceId: string, statements: readonly SqlStatement[]): Promise<void>;
  /** Injected clock for wait determinism. */
  now(): Date;
  /** URL of the dispatch SQS queue (the second queue → Dispatcher, §9). */
  readonly dispatchQueueUrl: string;
}

/** Terminal result of running one enrollment tick. */
export type RunEnrollmentResult =
  | { readonly result: 'advanced'; readonly endNode: string; readonly steps: number }
  | { readonly result: 'parked'; readonly node: string; readonly nextRunAt: Date }
  | { readonly result: 'completed'; readonly steps: number }
  | { readonly result: 'skipped'; readonly reason: string };

/** Max nodes processed in a single tick (loop guard, CLAUDE.md). */
export const MAX_STEPS_PER_TICK = 50;

interface EnrollmentRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly campaign_id: string;
  readonly profile_id: string;
  readonly current_node: string;
  readonly status: string;
  readonly next_run_at: Date | string | null;
  readonly updated_at: Date | string;
}

/**
 * Build the SQS message that enqueues an outbox id onto the DISPATCH queue. Body
 * is `{ outbox_id }` ONLY (the Dispatcher loads workspace_id from the row,
 * CLAUDE.md inv.2) — matching the dispatcher's parseOutboxIdFromSqsRecord
 * contract used by broadcasts.
 */
export function buildDispatchEnqueueMessage(
  outboxId: string,
  queueUrl: string,
): SendMessageCommand {
  return new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ outbox_id: outboxId }),
  });
}

/**
 * Run one enrollment tick. Loads the enrollment row (workspace_id FROM the row),
 * claims it via CAS on updated_at, then chains nodes until a wait/exit boundary,
 * committing side effects + the guarded advance in one tx, and finally enqueues
 * any outbox sends. Safe under retries + concurrency (the claim wins once).
 */
export async function runEnrollment(
  deps: RunDeps,
  enrollmentId: string,
): Promise<RunEnrollmentResult> {
  // 1. Load the enrollment row. workspace_id comes FROM the row.
  const { rows } = await deps.reader.query<EnrollmentRow>(
    `SELECT id, workspace_id, campaign_id, profile_id, current_node, status,
            next_run_at, updated_at::text AS updated_at
     FROM campaign_enrollments WHERE id = $1`,
    [enrollmentId],
  );
  const row = rows[0];
  if (!row) return { result: 'skipped', reason: 'enrollment not found' };
  if (row.status !== 'active') {
    return { result: 'skipped', reason: `not active (status=${row.status})` };
  }
  const workspaceId = row.workspace_id;

  // 2. Load + validate the campaign definition.
  const { rows: campRows } = await deps.reader.query<{ definition: unknown }>(
    `SELECT definition FROM campaigns WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, row.campaign_id],
  );
  const def = campRows[0]?.definition;
  if (def === undefined) return { result: 'skipped', reason: 'campaign not found' };
  let definition: CampaignDefinition;
  try {
    validateCampaignDefinition(def);
    definition = def;
  } catch (err) {
    return { result: 'skipped', reason: `invalid definition: ${(err as Error).message}` };
  }

  // 3. CLAIM via CAS on updated_at — only the winner proceeds.
  const claim = buildEnrollmentClaim(workspaceId, enrollmentId, row.updated_at);
  const { rows: claimed } = await deps.reader.query<EnrollmentRow>(claim.text, claim.values);
  if (claimed.length === 0) {
    return { result: 'skipped', reason: 'lost CAS claim (concurrent advance/retry)' };
  }
  const guardUpdatedAt: Date | string = claimed[0]!.updated_at;

  // 4. Chain through nodes in ONE tick up to a wait/exit boundary.
  const now = deps.now();
  let state: EnrollmentState = {
    id: row.id,
    workspace_id: workspaceId,
    campaign_id: row.campaign_id,
    profile_id: row.profile_id,
    current_node: row.current_node,
    status: 'active',
    next_run_at: row.next_run_at,
    updated_at: guardUpdatedAt,
  };

  const sends: SideEffect[] = [];
  const writes: SqlStatement[] = [];
  let arrival: Arrival = 'resumed'; // the swept node is being resumed
  let steps = 0;
  let currentNodeId = row.current_node;

  for (;;) {
    if (steps >= MAX_STEPS_PER_TICK) {
      // Loop guard: park as failed so a human can inspect (never spin).
      writes.push(
        buildAdvanceEnrollment(workspaceId, enrollmentId, guardUpdatedAt, {
          currentNode: currentNodeId,
          status: 'failed',
          nextRunAt: null,
        }),
      );
      await deps.runInWorkspaceTx(workspaceId, writes);
      return { result: 'skipped', reason: 'max steps per tick exceeded' };
    }
    steps += 1;

    const node: Node = findNode(definition, currentNodeId);

    // For a condition node, evaluate the branch against real profile_features.
    let matchesNow = false;
    if (node.type === 'condition') {
      const q = buildBranchMatchQuery(workspaceId, node.ast, row.profile_id);
      const { rows: matchRows } = await deps.reader.query<{ id: string }>(q.text, q.values);
      matchesNow = matchRows.length > 0;
    }

    const result: ProcessResult = processNode(node, state, matchesNow, now, arrival);

    if (result.disposition === 'stay') {
      // Wait boundary: park the enrollment at THIS node until nextRunAt.
      writes.push(
        buildAdvanceEnrollment(workspaceId, enrollmentId, guardUpdatedAt, {
          currentNode: currentNodeId,
          status: 'active',
          nextRunAt: result.nextRunAt,
        }),
      );
      await commit(deps, workspaceId, row.campaign_id, row.profile_id, writes, sends);
      return { result: 'parked', node: currentNodeId, nextRunAt: result.nextRunAt };
    }

    // Collect side effects, stamping the authoritative node id onto sends.
    for (const eff of result.sideEffects) {
      if (eff.kind === 'send') {
        sends.push({ ...eff, nodeId: currentNodeId });
        writes.push(
          buildCampaignOutboxInsert(
            workspaceId,
            row.campaign_id,
            row.profile_id,
            eff.templateId,
            currentNodeId,
          ),
        );
      } else {
        writes.push(buildSetAttribute(workspaceId, row.profile_id, eff.key, eff.value));
      }
    }

    if (result.disposition === 'complete') {
      writes.push(
        buildAdvanceEnrollment(workspaceId, enrollmentId, guardUpdatedAt, {
          currentNode: currentNodeId,
          status: 'completed',
          nextRunAt: null,
        }),
      );
      await commit(deps, workspaceId, row.campaign_id, row.profile_id, writes, sends);
      return { result: 'completed', steps };
    }

    // advance: move to the next node and keep chaining within this tick.
    currentNodeId = result.nextNode;
    arrival = 'arrived';
    state = { ...state, current_node: currentNodeId, next_run_at: null };
  }
}

/**
 * Commit the tick's writes (outbox inserts + set_attribute + guarded advance) in
 * ONE workspace-scoped tx, THEN enqueue the outbox ids onto the dispatch queue.
 * The advance is guarded by the claim's updated_at, so the whole tick is atomic
 * and at-most-once. Outbox ids are resolved by their (unique) dedupe keys.
 */
async function commit(
  deps: RunDeps,
  workspaceId: string,
  campaignId: string,
  profileId: string,
  writes: readonly SqlStatement[],
  sends: readonly SideEffect[],
): Promise<void> {
  await deps.runInWorkspaceTx(workspaceId, writes);

  const sendEffects = sends.filter(
    (s): s is Extract<SideEffect, { kind: 'send' }> => s.kind === 'send',
  );
  if (sendEffects.length === 0) return;

  // Resolve the outbox ids we just inserted (by their node-scoped dedupe_keys)
  // and enqueue each {outbox_id}. A send that lost the ON CONFLICT race (already
  // inserted by a prior tick) is still enqueued — the Dispatcher's atomic claim
  // makes the actual send exactly-once.
  const dedupeKeys = sendEffects.map((e) =>
    buildCampaignDedupeKey(campaignId, profileId, e.nodeId),
  );
  const { rows } = await deps.reader.query<{ id: string }>(
    `SELECT id FROM outbox WHERE workspace_id = $1 AND dedupe_key = ANY($2::text[])`,
    [workspaceId, dedupeKeys],
  );
  for (const ob of rows) {
    await deps.sqs.send(buildDispatchEnqueueMessage(ob.id, deps.dispatchQueueUrl));
  }
}
