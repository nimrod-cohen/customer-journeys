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
  isValidTimeZone,
  isJsSpec,
  resolveValueSpec,
  customerMerge,
  eventMerge,
  journeyMerge,
  renderExpression,
  type CustomerProfile,
} from '@cdp/shared';
import { evaluateJsValue } from './js-value.js';
import { executeWebhook, type WebhookHttpClient } from '@cdp/runner-webhook';
import {
  processNode,
  buildEnrollmentClaim,
  buildAdvanceEnrollment,
  buildBranchMatchQuery,
  rewriteTriggerEventLeaves,
  rewriteJourneyLeaves,
  buildCampaignOutboxInsert,
  buildCampaignDedupeKey,
  buildSetAttribute,
  buildSetJourney,
  buildWebhookActivityInsert,
  isEnrollableCampaignStatus,
  isRichWait,
  DEFAULT_WORKSPACE_TZ,
  type EnrollmentState,
  type SideEffect,
  type SqlStatement,
  type ProcessResult,
  type Arrival,
  type RichWaitInputs,
  type WaitPin,
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
  /**
   * The injected webhook HTTP client (§9B). Production wires a real fetch-based
   * client (honoring timeoutMs via AbortController); tests inject a fake. Optional
   * so the legacy in-memory unit tests (no webhook nodes) need not provide it; a
   * webhook side effect with no client is recorded as a failure (never hits a host).
   */
  readonly webhookClient?: WebhookHttpClient;
  /**
   * Decrypt an encrypted webhook auth-header secret at CALL time (never stored /
   * returned / logged in plaintext — @cdp/db secret-crypto envelope). Optional.
   */
  readonly decryptSecret?: (envelope: string) => string;
  /** Detect an encrypted-secret envelope inside a header value (@cdp/db). Optional. */
  readonly isEncryptedSecret?: (value: string) => boolean;
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
  /** The persisted enrollment state jsonb — carries the trigger event (event.*). */
  readonly state?: {
    event?: { payload?: Record<string, unknown> };
    /** Per-enrollment journey-vars map (freeform; written by `set_journey`). */
    journey?: Record<string, unknown>;
    /** Per-rich-wait pins, keyed by node id (state.wait.<nodeId> = {target,deadline}). */
    wait?: Record<string, WaitPin>;
  } | null;
}

/**
 * The recipient profile + the trigger event payload + the per-enrollment
 * journey vars that an in-tick set_attribute / set_journey resolves its value
 * expression against (customer.* / event.* / journey.*). Loaded once per tick
 * (profile post-lock; event + journey from the immutable enrollment.state).
 */
interface ResolveContext {
  readonly profile: CustomerProfile;
  readonly event?: unknown;
  /** The persisted per-enrollment journey-vars map (state.journey). */
  readonly journey?: unknown;
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
    | {
        readonly kind: 'park';
        readonly node: string;
        readonly nextRunAt: Date;
        /** A rich-wait pin to persist atomically with the park (state.wait.<nodeId>). */
        readonly waitPin?: { readonly nodeId: string; readonly pin: WaitPin };
      }
    | { readonly kind: 'complete'; readonly node: string }
    | { readonly kind: 'maxSteps'; readonly node: string };
  /** The outbox inserts + set_attribute writes accumulated during the tick. */
  readonly writes: readonly SqlStatement[];
  /** The send side effects (for resolving outbox ids → enqueue after commit). */
  readonly sends: readonly SideEffect[];
  /**
   * The webhook side effects collected this tick (node + authoritative nodeId).
   * Like sends, these are EXECUTED AFTER THE TX COMMITS (the external HTTP call
   * must never hold the FOR UPDATE lock) — see runWebhooks.
   */
  readonly webhooks: readonly Extract<SideEffect, { kind: 'webhook' }>[];
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
  tz: string,
  resolveCtx: ResolveContext,
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
  const webhooks: Extract<SideEffect, { kind: 'webhook' }>[] = [];
  const writes: SqlStatement[] = [];
  let arrival: Arrival = 'resumed'; // the swept node is being resumed
  let steps = 0;
  let currentNodeId = row.current_node;
  // The journey vars as they EVOLVE this tick: start from the persisted state, then
  // fold in each set_journey node's resolved values, so a LATER IF / set_journey / send
  // in the SAME tick sees them (the SQL write only commits at tx end). Without this a
  // "set journey var → branch on it" in one tick would read the stale start-of-tick state.
  let tickJourney: Record<string, unknown> = { ...((row.state?.journey as Record<string, unknown>) ?? {}) };

  for (;;) {
    if (steps >= MAX_STEPS_PER_TICK) {
      return { boundary: { kind: 'maxSteps', node: currentNodeId }, writes, sends, webhooks, steps };
    }
    steps += 1;

    const node: Node = findNode(definition, currentNodeId);

    // For a condition node, evaluate the branch against real profile_features.
    // Trigger-event leaves can't be SQL — evaluate them in-memory against the
    // enrolling event payload and fold them into the AST as constants first.
    let matchesNow = false;
    if (node.type === 'condition') {
      // Fold the in-memory-only leaves (trigger-event payload + journey vars from the
      // enrollment state) into constants BEFORE the SQL compile — neither lives on a
      // table the segment SQL touches.
      let ast = rewriteTriggerEventLeaves(node.ast, row.state?.event?.payload ?? null);
      ast = rewriteJourneyLeaves(ast, tickJourney);
      const q = buildBranchMatchQuery(workspaceId, ast, row.profile_id);
      const { rows: matchRows } = await read.query<{ id: string }>(q.text, q.values);
      matchesNow = matchRows.length > 0;
    }

    // RICH wait-until: resolve the condition gate (segment-style AST, evaluated like a
    // condition node), the {{timestamp}} anchor (rendered against the profile/event/
    // journey merge → a Date), and the persisted pin (state.wait.<nodeId>) so the
    // pure decideRichWait can decide advance-vs-park (proceed-on-timeout).
    let richWait: RichWaitInputs | null = null;
    if (node.type === 'wait' && isRichWait(node)) {
      let conditionMet = true;
      if (node.waitCondition !== undefined) {
        let ast = rewriteTriggerEventLeaves(node.waitCondition, row.state?.event?.payload ?? null);
        ast = rewriteJourneyLeaves(ast, tickJourney);
        const q = buildBranchMatchQuery(workspaceId, ast, row.profile_id);
        const { rows: matchRows } = await read.query<{ id: string }>(q.text, q.values);
        conditionMet = matchRows.length > 0;
      }
      let resolvedAnchor: Date | null = null;
      const off = node.untilOffset;
      if (off && off.anchor !== 'now') {
        const merge = {
          ...customerMerge(resolveCtx.profile),
          ...eventMerge(resolveCtx.event),
          ...journeyMerge(resolveCtx.journey),
        };
        const rendered = renderExpression(off.anchor, merge).trim();
        const d = rendered ? new Date(rendered) : null;
        resolvedAnchor = d && !Number.isNaN(d.getTime()) ? d : null;
      }
      const stored = (row.state?.wait as Record<string, WaitPin> | undefined)?.[currentNodeId] ?? null;
      richWait = { conditionMet, resolvedAnchor, pin: stored };
    }

    const result: ProcessResult = processNode(node, state, matchesNow, now, arrival, tz, richWait);

    if (result.disposition === 'stay') {
      // Wait / hour-window boundary: park the enrollment at THIS node until nextRunAt.
      const waitPin = result.waitPin;
      return {
        boundary: {
          kind: 'park',
          node: currentNodeId,
          nextRunAt: result.nextRunAt,
          ...(waitPin ? { waitPin: { nodeId: currentNodeId, pin: waitPin } } : {}),
        },
        writes,
        sends,
        webhooks,
        steps,
      };
    }

    // Collect side effects, stamping the authoritative node id onto sends/webhooks.
    for (const eff of result.sideEffects) {
      if (eff.kind === 'send') {
        sends.push({ ...eff, nodeId: currentNodeId });
        // A TEXT send (sms/whatsapp) carries its medium + plain body in the OUTBOX
        // PAYLOAD so the Dispatcher (which has no broadcast row for a campaign send)
        // renders {{customer.phone}} → provider via the existing text path. An EMAIL
        // send leaves the payload empty (its content lives on the template copy).
        // The per-node TOPIC rides the payload too so the dispatcher
        // can gate the send without an extra SELECT from campaigns.
        const payload: Record<string, unknown> =
          eff.medium !== 'email'
            ? { medium: eff.medium, text_body: eff.textBody ?? '' }
            : {};
        // A WhatsApp TEMPLATE send stamps `wa_template` (name/language/params) so the
        // dispatcher renders a type:'template' message (params rendered per recipient).
        if (eff.medium === 'whatsapp' && eff.waTemplate) payload.wa_template = eff.waTemplate;
        if (eff.topicId) payload.topic_id = eff.topicId;
        // Fold event.* + journey.* into payload.merge so the dispatcher's render
        // pass can substitute {{event.x}} / {{journey.x}} in templates / text
        // bodies (customer.* is added by the dispatcher from the recipient
        // profile). Skipped when there's nothing to add — keeps payload tidy.
        const extraMerge: Record<string, string> = {
          ...eventMerge(resolveCtx.event),
          ...journeyMerge(tickJourney),
        };
        if (Object.keys(extraMerge).length > 0) payload.merge = extraMerge;
        writes.push(
          buildCampaignOutboxInsert(
            workspaceId,
            row.campaign_id,
            row.profile_id,
            eff.templateId,
            currentNodeId,
            payload,
          ),
        );
      } else if (eff.kind === 'webhook') {
        // The HTTP call runs POST-COMMIT (runWebhooks); collect the intent here
        // with the authoritative node id (the per-(campaign,profile,node) dedupe key).
        webhooks.push({ ...eff, nodeId: currentNodeId });
      } else if (eff.kind === 'set_attribute' || eff.kind === 'set_journey') {
        // Resolve EACH assignment's value spec (literal | expression | js | legacy
        // bare scalar) against the recipient profile + the IMMUTABLE persisted trigger
        // event. A 'js' spec is evaluated NODE-side in a sandbox (evaluateJsValue);
        // everything else is read-only string substitution (never SQL — invariant 6
        // untouched). set_journey shares the resolution path, only the write target
        // differs (enrollment.state.journey vs profiles.attributes).
        //
        // SEQUENTIAL within the node: each assignment sees the ones ABOVE it. We
        // thread a MUTABLE working copy forward — a set_attribute row updates
        // customer.<key> (so {{customer.<key>}} below resolves to it); a set_journey
        // row updates journey.<key>. The final SQL write is still one nested jsonb_set,
        // but the values already incorporate the in-node dependencies. A retry
        // re-resolves identically from the immutable source (idempotent).
        const isJourney = eff.kind === 'set_journey';
        // Mutable working copies threaded forward across rows in THIS node. The journey
        // copy starts from `tickJourney` (incl. any set_journey EARLIER this tick), not
        // the stale start-of-tick state, so cross-node journey dependencies resolve.
        const workAttrs: Record<string, unknown> = { ...(resolveCtx.profile.attributes ?? {}) };
        const workJourney: Record<string, unknown> = { ...tickJourney };
        const resolved: { key: string; value: unknown }[] = [];
        for (const a of eff.assignments) {
          const valueCtx = {
            profile: { ...resolveCtx.profile, attributes: workAttrs } as CustomerProfile,
            ...(resolveCtx.event !== undefined ? { event: resolveCtx.event } : {}),
            journey: workJourney,
          };
          const value = isJsSpec(a.value) ? evaluateJsValue(a.value.code, valueCtx) : resolveValueSpec(a.value, valueCtx);
          resolved.push({ key: a.key, value });
          // Thread this row's result forward so a LATER row in the SAME node reads it
          // (a set_attribute row → customer.<key>; a set_journey row → journey.<key>).
          if (isJourney) workJourney[a.key] = value;
          else workAttrs[a.key] = value;
        }
        if (isJourney) {
          writes.push(buildSetJourney(workspaceId, row.id, resolved));
          // Fold this node's resolved journey vars into the tick state so a LATER
          // IF / set_journey / send this tick sees them (matches the committed write).
          tickJourney = { ...tickJourney, ...Object.fromEntries(resolved.map((r) => [r.key, r.value])) };
        } else {
          writes.push(buildSetAttribute(workspaceId, row.profile_id, resolved));
        }
      }
    }

    if (result.disposition === 'complete') {
      return { boundary: { kind: 'complete', node: currentNodeId }, writes, sends, webhooks, steps };
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
        ...(b.waitPin ? { waitPin: b.waitPin } : {}),
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
    webhooks: { campaignId: string; profileId: string; workspaceId: string; list: readonly Extract<SideEffect, { kind: 'webhook' }>[] } | null;
  }> => {
    // 1. Lock the enrollment row for the whole tick. A concurrent run blocks here
    //    until we commit, then sees the advanced status and skips below.
    const { rows } = await tx.query<EnrollmentRow>(
      `SELECT id, workspace_id, campaign_id, profile_id, current_node, status,
              next_run_at, updated_at::text AS updated_at, state
       FROM campaign_enrollments WHERE id = $1 FOR UPDATE`,
      [enrollmentId],
    );
    const row = rows[0];
    if (!row) return { result: { result: 'skipped', reason: 'enrollment not found' }, enqueue: null, webhooks: null };
    // Re-check status INSIDE the lock: a run that was blocked here now sees the
    // status the winner committed (completed/active-with-future-next_run_at).
    if (row.status !== 'active') {
      return {
        result: { result: 'skipped', reason: `not active (status=${row.status})` },
        enqueue: null,
        webhooks: null,
      };
    }
    const workspaceId = row.workspace_id;

    // 2. Load + validate the campaign definition (same tx client) and the
    //    WORKSPACE timezone (governs all window/wait time math, never per-broadcast).
    //    The campaign STATUS is read INSIDE the lock too: only an 'active' campaign
    //    advances (§9B phase 7). A paused/archived campaign's due enrollment is
    //    left PARKED exactly where it is (no node move, no send, no webhook) — a
    //    reversible halt, not a data mutation. Resuming (status→'active') lets the
    //    next sweep advance it normally. The FOR UPDATE lock + idempotency are
    //    unchanged: we simply decline to advance while paused.
    const { rows: campRows } = await tx.query<{ definition: unknown; status: string }>(
      `SELECT definition, status FROM campaigns WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, row.campaign_id],
    );
    const def = campRows[0]?.definition;
    if (def === undefined) {
      return { result: { result: 'skipped', reason: 'campaign not found' }, enqueue: null, webhooks: null };
    }
    if (!isEnrollableCampaignStatus(campRows[0]?.status)) {
      return {
        result: { result: 'skipped', reason: `campaign not active (status=${campRows[0]?.status})` },
        enqueue: null,
        webhooks: null,
      };
    }
    let definition: CampaignDefinition;
    try {
      validateCampaignDefinition(def);
      definition = def;
    } catch (err) {
      return {
        result: { result: 'skipped', reason: `invalid definition: ${(err as Error).message}` },
        enqueue: null,
        webhooks: null,
      };
    }
    const tz = await loadWorkspaceTz(tx, workspaceId);

    // 3. Chain nodes. The guard token is the current updated_at — but under the
    //    row lock the advance is unconditional in practice; we keep the guard for
    //    defense in depth (it always matches since we hold the lock).
    const guardUpdatedAt = row.updated_at;
    // Load the recipient profile (for customer.* in a set_attribute expression) +
    // the trigger event from the locked, immutable enrollment.state (for event.*).
    const resolveCtx = await loadResolveContext(tx, workspaceId, row);
    const outcome = await chainTick(tx, workspaceId, definition, row, guardUpdatedAt, now, tz, resolveCtx);

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
    const webhooks =
      b.kind === 'maxSteps' || outcome.webhooks.length === 0
        ? null
        : {
            campaignId: row.campaign_id,
            profileId: row.profile_id,
            workspaceId,
            list: outcome.webhooks,
          };
    return { result, enqueue, webhooks };
  });

  // 5. AFTER commit (mirrors enqueueSends): the external webhook HTTP call runs
  //    here, NEVER inside the FOR UPDATE tx (a hung host must not hold the row
  //    lock). Single-winner already advanced the enrollment exactly once, so this
  //    fires AT-MOST-ONCE; the per-(campaign,profile,node) activity_log dedupe
  //    short-circuits a crash-recovery re-fire. Failure is isolated (continue).
  if (committed.webhooks) {
    await runWebhooks(
      deps,
      committed.webhooks.workspaceId,
      committed.webhooks.campaignId,
      committed.webhooks.profileId,
      committed.webhooks.list,
    );
  }

  // 6. AFTER commit: resolve outbox ids and enqueue {outbox_id}. We use the
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
            next_run_at, updated_at::text AS updated_at, state
     FROM campaign_enrollments WHERE id = $1`,
    [enrollmentId],
  );
  const row = rows[0];
  if (!row) return { result: 'skipped', reason: 'enrollment not found' };
  if (row.status !== 'active') {
    return { result: 'skipped', reason: `not active (status=${row.status})` };
  }
  const workspaceId = row.workspace_id;

  // 2. Load + validate the campaign definition. Read the campaign STATUS too: a
  //    paused/archived campaign does NOT advance (§9B phase 7) — the enrollment is
  //    left parked where it is (the CAS claim below is never taken).
  const { rows: campRows } = await deps.reader.query<{ definition: unknown; status: string }>(
    `SELECT definition, status FROM campaigns WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, row.campaign_id],
  );
  const def = campRows[0]?.definition;
  if (def === undefined) return { result: 'skipped', reason: 'campaign not found' };
  if (!isEnrollableCampaignStatus(campRows[0]?.status)) {
    return { result: 'skipped', reason: `campaign not active (status=${campRows[0]?.status})` };
  }
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

  // 4. Chain through nodes in ONE tick up to a wait/exit boundary (tz-aware).
  const now = deps.now();
  const tz = await loadWorkspaceTz(deps.reader, workspaceId);
  const resolveCtx = await loadResolveContext(deps.reader, workspaceId, row);
  const outcome = await chainTick(deps.reader, workspaceId, definition, row, guardUpdatedAt, now, tz, resolveCtx);
  const writes = advanceFor(workspaceId, enrollmentId, guardUpdatedAt, outcome);

  await deps.runInWorkspaceTx(workspaceId, writes);

  const b = outcome.boundary;
  if (b.kind === 'maxSteps') {
    return { result: 'skipped', reason: 'max steps per tick exceeded' };
  }
  // Post-commit side effects (mirror enqueueSends): the webhook HTTP call + the
  // outbox enqueue run AFTER the write tx, never under any lock.
  await runWebhooks(deps, workspaceId, row.campaign_id, row.profile_id, outcome.webhooks);
  await enqueueSends(deps, workspaceId, row.campaign_id, row.profile_id, outcome.sends);
  if (b.kind === 'park') return { result: 'parked', node: b.node, nextRunAt: b.nextRunAt };
  return { result: 'completed', steps: outcome.steps };
}

/**
 * Read the WORKSPACE timezone (workspaces.settings->>'timezone') governing all
 * campaign window/wait time math. Defaults to UTC when unset or invalid — parity
 * with the local-api handlers. workspace_id is the enrollment's (never assumed).
 */
async function loadWorkspaceTz(read: Reader, workspaceId: string): Promise<string> {
  const { rows } = await read.query<{ tz: string | null }>(
    `SELECT settings->>'timezone' AS tz FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  const tz = rows[0]?.tz;
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_WORKSPACE_TZ;
}

/**
 * Load the value-resolution context for a tick: the recipient profile (for a
 * set_attribute expression's customer.* tokens) + the trigger event payload from
 * the enrollment's IMMUTABLE persisted state (for event.* tokens). workspace_id is
 * the enrollment's (bound at $1). The event comes from state.event.payload (written
 * at event enrollment); absent for segment/manual enrollment → an event.* token
 * resolves safe-empty. A retry re-reads the SAME state, so the resolution is stable
 * (idempotent jsonb_set). A missing profile falls back to a minimal {id} shape.
 */
async function loadResolveContext(
  read: Reader,
  workspaceId: string,
  row: EnrollmentRow,
): Promise<ResolveContext> {
  const { rows } = await read.query<CustomerProfile>(
    `SELECT id, email, external_id, email_status, created_at, attributes
     FROM profiles WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, row.profile_id],
  );
  const profile: CustomerProfile = rows[0] ?? { id: row.profile_id };
  const event = row.state?.event?.payload;
  const journey = row.state?.journey;
  const ctx: ResolveContext = { profile };
  return Object.assign(
    ctx,
    event !== undefined ? { event } : null,
    journey !== undefined ? { journey } : null,
  );
}

/**
 * Execute the webhook side effects collected this tick — AFTER the row-lock tx
 * committed (the external HTTP call must never hold the FOR UPDATE lock). For each:
 *   - load the recipient profile (post-commit reader) and run executeWebhook
 *     (allowlist/SSRF guard FIRST → render body → injected client + bounded retry);
 *   - record the outcome in an append-only activity_log row keyed by the
 *     per-(campaign,profile,node) dedupe key (ON CONFLICT DO NOTHING → at-most-once,
 *     never double-fires on a crash-recovery re-sweep).
 * NEVER throws: a webhook is a notification side effect, not a journey gate, so a
 * failed/blocked call is recorded and the enrollment (already advanced) continues.
 * workspace_id is the enrollment's (bound at $1 in every statement).
 */
async function runWebhooks(
  deps: RunDeps,
  workspaceId: string,
  campaignId: string,
  profileId: string,
  webhooks: readonly Extract<SideEffect, { kind: 'webhook' }>[],
): Promise<void> {
  if (webhooks.length === 0) return;

  // The per-workspace host allowlist (deny-by-default) lives in workspaces.settings
  // (never client-trusted, inv.2). Loaded once for the whole tick.
  const allowlist = await loadWebhookAllowlist(deps.reader, workspaceId);

  // Load the recipient profile for {{customer.*}} body rendering (email-parity).
  const { rows: profRows } = await deps.reader.query<CustomerProfile>(
    `SELECT id, email, external_id, email_status, created_at, attributes
     FROM profiles WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, profileId],
  );
  const profile: CustomerProfile = profRows[0] ?? { id: profileId };

  for (const wh of webhooks) {
    let activity: SqlStatement;
    if (!deps.webhookClient) {
      // No client wired (legacy unit path) — record as failed; never hit a host.
      activity = buildWebhookActivityInsert(workspaceId, profileId, campaignId, wh.nodeId, {
        ok: false,
        attempts: 0,
        error: 'no webhook client configured',
      });
    } else {
      const outcome = await executeWebhook(deps.webhookClient, wh.node, profile, {
        allowlist,
        ...(deps.decryptSecret ? { decryptSecret: deps.decryptSecret } : {}),
        ...(deps.isEncryptedSecret ? { isEncryptedSecret: deps.isEncryptedSecret } : {}),
      });
      activity =
        outcome.error === 'blocked' && outcome.attempts === 0
          ? buildWebhookActivityInsert(workspaceId, profileId, campaignId, wh.nodeId, { blocked: true })
          : buildWebhookActivityInsert(workspaceId, profileId, campaignId, wh.nodeId, outcome);
    }
    try {
      await deps.runInWorkspaceTx(workspaceId, [activity]);
    } catch {
      /* isolate: a failed activity write must not crash the sweep / double-advance */
    }
  }
}

/**
 * Load the per-workspace webhook host allowlist from workspaces.settings
 * (`settings->'webhook_allowlist'`, an array of host strings). Deny-by-default:
 * a missing/invalid setting yields an EMPTY allowlist (every host refused) so
 * outbound HTTP is strictly opt-in per workspace (inv. webhook safety).
 */
async function loadWebhookAllowlist(read: Reader, workspaceId: string): Promise<string[]> {
  const { rows } = await read.query<{ allowlist: unknown }>(
    `SELECT settings->'webhook_allowlist' AS allowlist FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  const raw = rows[0]?.allowlist;
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is string => typeof h === 'string' && h.length > 0);
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
