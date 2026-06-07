// Campaign-runner per-enrollment orchestrator (§9B). Given a swept enrollment
// row, it runs the WHOLE tick inside ONE transaction so a second concurrent
// run cannot claim the enrollment mid-tick:
//   1. BEGIN, then SELECT … FOR UPDATE the enrollment row (pessimistic row lock,
//      re-checking status='active' INSIDE the lock). A second concurrent run
//      blocks here until the first commits, then sees status='completed'/advanced
//      and skips — so exactly one tick advances a due enrollment, deterministically.
//   2. Processes node(s) in ONE tick on the SAME tx client: chains through
//      trigger/condition/action nodes until a WAIT boundary or an EXIT (with a
//      MAX_STEPS_PER_TICK loop guard so a pathological graph can't spin forever).
//   3. Applies action sends (outbox row with a node-scoped dedupe_key) and
//      set_attribute writes plus the guarded advance — all on the SAME tx client.
//   4. COMMIT. Then enqueues each {outbox_id} onto the dispatch queue AFTER the
//      commit (the Dispatcher's atomic claim makes the actual send exactly-once).
//
// workspace_id is loaded FROM the enrollment row (never assumed). All sends flow
// through the real Dispatcher — this module only inserts outbox + enqueues ids.
//
// A legacy reader/runInWorkspaceTx path is retained for the in-memory unit tests
// (deps without `withTx`); the real concurrency guarantee comes from `withTx`.
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

/**
 * A tx-scoped client: a single Postgres connection inside an open transaction.
 * The WHOLE tick (the FOR UPDATE lock, all reads, all writes, the advance) runs
 * against this one client so the enrollment row lock is held for the tick.
 */
export interface TxClient {
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
  /**
   * Run `fn` inside ONE transaction, giving it a tx-scoped client used for BOTH
   * the reads and the writes of the whole tick (so the enrollment row lock from
   * `SELECT … FOR UPDATE` is held until COMMIT). The tx commits when `fn`
   * resolves and rolls back if it throws. When provided, this is the production
   * path that gives the deterministic single-winner concurrency guarantee.
   * `fn`'s return value is propagated.
   */
  withTx?<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  /**
   * Legacy: apply a list of statements in ONE workspace-scoped tx (atomic write).
   * Used by in-memory unit tests; the production path uses `withTx` instead.
   */
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

/** What a chained tick decided, before the boundary write is applied. */
interface TickOutcome {
  /** The boundary that ended the tick. */
  readonly boundary:
    | { readonly kind: 'park'; readonly node: string; readonly nextRunAt: Date }
    | { readonly kind: 'complete'; readonly node: string }
    | { readonly kind: 'maxSteps'; readonly node: string };
  /** The outbox inserts + set_attribute writes accumulated during the tick. */
  readonly writes: readonly SqlStatement[];
  /** The send side effects (for resolving outbox ids → enqueue after commit). */
  readonly sends: readonly SideEffect[];
  /** Number of nodes processed (reported on completion). */
  readonly steps: number;
}

/**
 * Chain through the campaign nodes for ONE tick, up to a wait/exit boundary (or
 * the MAX_STEPS_PER_TICK guard). PURE w.r.t. persistence: it reads (campaign
 * branch matches) via `read` and accumulates writes; the caller applies them
 * (the guarded/locked advance is appended by the caller, since it depends on the
 * boundary). `read` runs on the SAME connection as the eventual writes in the
 * single-tx path (so reads see the locked row state), or on the reader in the
 * legacy CAS path.
 */
async function chainTick(
  read: Reader,
  workspaceId: string,
  definition: CampaignDefinition,
  row: EnrollmentRow,
  guardUpdatedAt: Date | string,
  now: Date,
): Promise<TickOutcome> {
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
      return { boundary: { kind: 'maxSteps', node: currentNodeId }, writes, sends, steps };
    }
    steps += 1;

    const node: Node = findNode(definition, currentNodeId);

    // For a condition node, evaluate the branch against real profile_features.
    let matchesNow = false;
    if (node.type === 'condition') {
      const q = buildBranchMatchQuery(workspaceId, node.ast, row.profile_id);
      const { rows: matchRows } = await read.query<{ id: string }>(q.text, q.values);
      matchesNow = matchRows.length > 0;
    }

    const result: ProcessResult = processNode(node, state, matchesNow, now, arrival);

    if (result.disposition === 'stay') {
      // Wait boundary: park the enrollment at THIS node until nextRunAt.
      return {
        boundary: { kind: 'park', node: currentNodeId, nextRunAt: result.nextRunAt },
        writes,
        sends,
        steps,
      };
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
      return { boundary: { kind: 'complete', node: currentNodeId }, writes, sends, steps };
    }

    // advance: move to the next node and keep chaining within this tick.
    currentNodeId = result.nextNode;
    arrival = 'arrived';
    state = { ...state, current_node: currentNodeId, next_run_at: null };
  }
}

/** Append the guarded/locked advance for a tick outcome to its write list. */
function advanceFor(
  workspaceId: string,
  enrollmentId: string,
  guardUpdatedAt: Date | string,
  outcome: TickOutcome,
): SqlStatement[] {
  const writes = [...outcome.writes];
  const b = outcome.boundary;
  if (b.kind === 'park') {
    writes.push(
      buildAdvanceEnrollment(workspaceId, enrollmentId, guardUpdatedAt, {
        currentNode: b.node,
        status: 'active',
        nextRunAt: b.nextRunAt,
      }),
    );
  } else if (b.kind === 'complete') {
    writes.push(
      buildAdvanceEnrollment(workspaceId, enrollmentId, guardUpdatedAt, {
        currentNode: b.node,
        status: 'completed',
        nextRunAt: null,
      }),
    );
  } else {
    // maxSteps: park as failed so a human can inspect (never spin).
    writes.push(
      buildAdvanceEnrollment(workspaceId, enrollmentId, guardUpdatedAt, {
        currentNode: b.node,
        status: 'failed',
        nextRunAt: null,
      }),
    );
  }
  return writes;
}

/**
 * Run one enrollment tick. When `deps.withTx` is provided (production), the WHOLE
 * tick runs in ONE transaction holding a `SELECT … FOR UPDATE` row lock, so a
 * second concurrent run blocks until commit and then skips — exactly one tick
 * advances a due enrollment, deterministically. When `withTx` is absent (the
 * in-memory unit tests), it falls back to the CAS-claim path. After a tx commit,
 * outbox ids are resolved and enqueued onto the dispatch queue.
 */
export async function runEnrollment(
  deps: RunDeps,
  enrollmentId: string,
): Promise<RunEnrollmentResult> {
  return deps.withTx
    ? runEnrollmentInTx(deps, deps.withTx, enrollmentId)
    : runEnrollmentLegacy(deps, enrollmentId);
}

/**
 * Production path: hold the enrollment row lock for the whole tick in one tx.
 *   BEGIN → SELECT … FOR UPDATE (re-check active INSIDE the lock) → process all
 *   nodes + apply all writes (outbox/set_attribute/advance) on the SAME client →
 *   COMMIT → enqueue {outbox_id} messages.
 * A second concurrent run blocks on FOR UPDATE until this commits, then reads the
 * advanced/completed status and skips. No CAS needed — the lock is the guarantee.
 */
async function runEnrollmentInTx(
  deps: RunDeps,
  withTx: NonNullable<RunDeps['withTx']>,
  enrollmentId: string,
): Promise<RunEnrollmentResult> {
  const now = deps.now();
  const committed = await withTx(async (tx): Promise<{
    result: RunEnrollmentResult;
    enqueue: { campaignId: string; profileId: string; workspaceId: string; sends: SideEffect[] } | null;
  }> => {
    // 1. Lock the enrollment row for the whole tick. A concurrent run blocks here
    //    until we commit, then sees the advanced status and skips below.
    const { rows } = await tx.query<EnrollmentRow>(
      `SELECT id, workspace_id, campaign_id, profile_id, current_node, status,
              next_run_at, updated_at::text AS updated_at
       FROM campaign_enrollments WHERE id = $1 FOR UPDATE`,
      [enrollmentId],
    );
    const row = rows[0];
    if (!row) return { result: { result: 'skipped', reason: 'enrollment not found' }, enqueue: null };
    // Re-check status INSIDE the lock: a run that was blocked here now sees the
    // status the winner committed (completed/active-with-future-next_run_at).
    if (row.status !== 'active') {
      return {
        result: { result: 'skipped', reason: `not active (status=${row.status})` },
        enqueue: null,
      };
    }
    const workspaceId = row.workspace_id;

    // 2. Load + validate the campaign definition (same tx client).
    const { rows: campRows } = await tx.query<{ definition: unknown }>(
      `SELECT definition FROM campaigns WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, row.campaign_id],
    );
    const def = campRows[0]?.definition;
    if (def === undefined) {
      return { result: { result: 'skipped', reason: 'campaign not found' }, enqueue: null };
    }
    let definition: CampaignDefinition;
    try {
      validateCampaignDefinition(def);
      definition = def;
    } catch (err) {
      return {
        result: { result: 'skipped', reason: `invalid definition: ${(err as Error).message}` },
        enqueue: null,
      };
    }

    // 3. Chain nodes. The guard token is the current updated_at — but under the
    //    row lock the advance is unconditional in practice; we keep the guard for
    //    defense in depth (it always matches since we hold the lock).
    const guardUpdatedAt = row.updated_at;
    const outcome = await chainTick(tx, workspaceId, definition, row, guardUpdatedAt, now);

    // 4. Apply all writes (outbox/set_attribute) + the boundary advance.
    const writes = advanceFor(workspaceId, enrollmentId, guardUpdatedAt, outcome);
    for (const s of writes) {
      if (s.values[0] !== workspaceId) {
        throw new Error('runEnrollment: write not scoped to the enrollment workspace');
      }
      await tx.query(s.text, s.values);
    }

    const b = outcome.boundary;
    const result: RunEnrollmentResult =
      b.kind === 'park'
        ? { result: 'parked', node: b.node, nextRunAt: b.nextRunAt }
        : b.kind === 'complete'
          ? { result: 'completed', steps: outcome.steps }
          : { result: 'skipped', reason: 'max steps per tick exceeded' };

    const enqueue =
      b.kind === 'maxSteps'
        ? null
        : {
            campaignId: row.campaign_id,
            profileId: row.profile_id,
            workspaceId,
            sends: [...outcome.sends],
          };
    return { result, enqueue };
  });

  // 5. AFTER commit: resolve outbox ids and enqueue {outbox_id}. We use the
  //    (post-commit) reader so the rows are visible.
  if (committed.enqueue) {
    await enqueueSends(
      deps,
      committed.enqueue.workspaceId,
      committed.enqueue.campaignId,
      committed.enqueue.profileId,
      committed.enqueue.sends,
    );
  }
  return committed.result;
}

/**
 * Legacy CAS path (in-memory unit tests / deps without `withTx`). Loads the row,
 * claims via CAS on updated_at, chains nodes, then commits the writes + guarded
 * advance via runInWorkspaceTx and enqueues sends. Kept so the engine's pure
 * decision logic is unit-testable without Postgres.
 */
async function runEnrollmentLegacy(
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
  const outcome = await chainTick(deps.reader, workspaceId, definition, row, guardUpdatedAt, now);
  const writes = advanceFor(workspaceId, enrollmentId, guardUpdatedAt, outcome);

  await deps.runInWorkspaceTx(workspaceId, writes);

  const b = outcome.boundary;
  if (b.kind === 'maxSteps') {
    return { result: 'skipped', reason: 'max steps per tick exceeded' };
  }
  await enqueueSends(deps, workspaceId, row.campaign_id, row.profile_id, outcome.sends);
  if (b.kind === 'park') return { result: 'parked', node: b.node, nextRunAt: b.nextRunAt };
  return { result: 'completed', steps: outcome.steps };
}

/**
 * Resolve the outbox ids we inserted (by their node-scoped dedupe_keys) and
 * enqueue each {outbox_id} onto the dispatch queue. A send that lost the ON
 * CONFLICT race (already inserted by a prior tick) is still enqueued — the
 * Dispatcher's atomic claim makes the actual send exactly-once.
 */
async function enqueueSends(
  deps: RunDeps,
  workspaceId: string,
  campaignId: string,
  profileId: string,
  sends: readonly SideEffect[],
): Promise<void> {
  const sendEffects = sends.filter(
    (s): s is Extract<SideEffect, { kind: 'send' }> => s.kind === 'send',
  );
  if (sendEffects.length === 0) return;

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
