// Enrollment orchestrator (§9B). A segment entry (segment_change_log 'entered')
// drives automation enrollment: resolve the active automations whose
// trigger_segment_id matches the changed segment, decide re-enrollment, and
// insert an enrollment row at the start node — ALL in a workspace-scoped tx
// (the structural ON CONFLICT (automation_id, profile_id) DO NOTHING is the real
// 'once' guard, so a retry/double-fire enrolls at most once).
//
// CRITICAL invariants enforced here:
//   - 'entered' enrolls; 'exited' produces NO enrollment.
//   - cross-workspace isolation: only automations in the change-log's workspace
//     are considered, and every write binds workspace_id at $1.
//
// Three trigger kinds funnel through buildEnrollmentInsert (re-enrollment 'once'):
//   - segment_entry → enrollFromSegmentChange (wired at processor segment-reeval)
//   - event         → enrollFromEvent (wired at processor/ingest event landing)
//   - manual/API    → enrollProfileManually / enrollSegmentSnapshot (the endpoint)
import {
  parseEnrollmentTrigger,
  parseEventEnrollmentTrigger,
  parseProfileEnrollmentTrigger,
  evaluateEventPayloadFilter,
  buildEnrollmentInsert,
  buildEnrollmentInsertWithState,
  parseKeepWhileInCancellations,
  buildEnrollmentCancel,
  type SegmentChangeLogRow,
  type EventRow,
  type EventAutomationTriggerRow,
  type ProfileChangeRow,
  type ProfileAutomationTriggerRow,
  type AutomationTriggerRow,
  type AutomationKeepRow,
  type EnrollmentIntent,
  type SqlStatement,
} from './core.js';
import { buildResolveAudience, type AstNode } from '@cdp/segments';
import { resolveStartNode, validateAutomationDefinition, type TriggerNode } from './dsl.js';

/** A minimal query reader (returns rows). The orchestrator never opens a tx. */
export interface Reader {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Injected dependencies for the enrollment orchestrator. */
export interface EnrollDeps {
  /** Service-role reader (bypasses RLS → in-code scoping is the guard). */
  readonly reader: Reader;
  /** Apply a list of statements in ONE workspace-scoped tx (atomic write). */
  runInWorkspaceTx(workspaceId: string, statements: readonly SqlStatement[]): Promise<void>;
}

/** The outcome of processing one segment_change_log row. */
export interface EnrollResult {
  readonly enrolled: number;
  readonly intents: readonly EnrollmentIntent[];
  /** Active enrollments ended because the profile left a keep_while_in_segment. */
  readonly cancelled: number;
}

interface AutomationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly trigger_segment_id: string | null;
  readonly trigger_on?: 'enter' | 'exit';
  readonly definition: unknown;
}

/**
 * Enroll profiles into automations triggered by a segment_change_log row. Reads
 * the active automations for the row's workspace whose trigger_segment_id matches
 * the changed segment, resolves each one's start node from its definition, then
 * inserts the enrollment(s) in a workspace-scoped tx. 'exited' is a no-op.
 */
export async function enrollFromSegmentChange(
  deps: EnrollDeps,
  row: SegmentChangeLogRow,
): Promise<EnrollResult> {
  if (!row.workspace_id) throw new Error('enrollFromSegmentChange: workspace_id is required');
  if (row.action !== 'entered' && row.action !== 'exited') return { enrolled: 0, intents: [], cancelled: 0 };

  // Load active automations for THIS workspace triggered by THIS segment. Whether a
  // automation fires on this row is decided by trigger_on vs the action (parseEnrollmentTrigger).
  const { rows: automationRows } = await deps.reader.query<AutomationRow>(
    `SELECT id, workspace_id, trigger_segment_id, trigger_on, definition
     FROM automations
     WHERE workspace_id = $1 AND status = 'active' AND trigger_segment_id = $2`,
    [row.workspace_id, row.segment_id],
  );

  // Resolve each automation's start node from its (validated) definition.
  const triggerRows: AutomationTriggerRow[] = [];
  for (const c of automationRows) {
    let startNode: string;
    try {
      validateAutomationDefinition(c.definition);
      // The start node IS the trigger (validateAutomationDefinition guarantees one
      // trigger + a resolvable startNode); resolveStartNode asserts it exists.
      resolveStartNode(c.definition);
      startNode = c.definition.startNode;
    } catch {
      continue; // skip an invalid automation definition rather than crash the sweep
    }
    triggerRows.push({
      id: c.id,
      workspace_id: c.workspace_id,
      trigger_segment_id: c.trigger_segment_id,
      start_node: startNode,
      trigger_on: c.trigger_on ?? 'enter',
    });
  }

  const intents = parseEnrollmentTrigger(row, triggerRows);

  // On 'exited', also CANCEL active enrollments in automations that require staying
  // in this segment (keep_while_in_segment) — the profile no longer qualifies.
  let cancelIntents: ReturnType<typeof parseKeepWhileInCancellations> = [];
  if (row.action === 'exited') {
    const { rows: keepRows } = await deps.reader.query<AutomationKeepRow>(
      `SELECT id, workspace_id, keep_while_in_segment FROM automations
       WHERE workspace_id = $1 AND status = 'active' AND keep_while_in_segment = $2`,
      [row.workspace_id, row.segment_id],
    );
    cancelIntents = parseKeepWhileInCancellations(row, keepRows);
  }

  // Apply enrollments (ON CONFLICT DO NOTHING) + cancellations in ONE workspace tx.
  const statements: SqlStatement[] = [
    ...intents.map((i) => buildEnrollmentInsert(i.workspaceId, i.automationId, i.profileId, i.startNode)),
    ...cancelIntents.map((c) => buildEnrollmentCancel(c.workspaceId, c.automationId, c.profileId)),
  ];
  if (statements.length > 0) await deps.runInWorkspaceTx(row.workspace_id, statements);

  return { enrolled: intents.length, intents, cancelled: cancelIntents.length };
}

/** The outcome of an event/manual enroll call. */
export interface SimpleEnrollResult {
  readonly enrolled: number;
  readonly intents: readonly EnrollmentIntent[];
}

/**
 * Enroll a profile into the active EVENT-trigger automations matched by an INGESTED
 * EVENT (§9B) — the event analogue of enrollFromSegmentChange. Reads the active
 * automations in the event's workspace, resolves each one's trigger node, keeps only
 * those whose kind='event' eventType equals the event type, evaluates the optional
 * payload filter against the event payload (pure, in-memory), then inserts the
 * enrollment(s) at the start node in ONE workspace-scoped tx. The ON CONFLICT
 * 'once' guard makes a replayed event enroll at most once. Tenant isolation:
 * automations are read WHERE workspace_id=$1 and every write binds workspace_id at $1.
 */
export async function enrollFromEvent(deps: EnrollDeps, row: EventRow): Promise<SimpleEnrollResult> {
  if (!row.workspace_id) throw new Error('enrollFromEvent: workspace_id is required');

  // Active automations in THIS workspace (the event type / trigger kind is resolved
  // from each definition; an in-SQL definition filter is brittle, so we read the
  // small active set and resolve in code — mirrors enrollFromSegmentChange).
  const { rows: automationRows } = await deps.reader.query<AutomationRow>(
    `SELECT id, workspace_id, trigger_segment_id, trigger_on, definition
     FROM automations
     WHERE workspace_id = $1 AND status = 'active'`,
    [row.workspace_id],
  );

  const triggerRows: EventAutomationTriggerRow[] = [];
  for (const c of automationRows) {
    let trigger: TriggerNode;
    let startNode: string;
    try {
      validateAutomationDefinition(c.definition);
      const node = resolveStartNode(c.definition);
      if (node.type !== 'trigger' || node.kind !== 'event') continue; // only event triggers
      trigger = node;
      startNode = c.definition.startNode;
    } catch {
      continue; // skip an invalid definition rather than crash the hook
    }
    if (!trigger.eventType || trigger.eventType !== row.type) continue;
    // Evaluate the optional payload filter against the event payload (closed grammar).
    const matchesFilter = evaluateEventPayloadFilter(trigger.filter as AstNode | undefined, row.payload);
    triggerRows.push({
      id: c.id,
      workspace_id: c.workspace_id,
      event_type: trigger.eventType,
      start_node: startNode,
      matchesFilter,
    });
  }

  const intents = parseEventEnrollmentTrigger(row, triggerRows);
  // Persist the trigger event onto enrollment.state.event (so a later set_attribute
  // step can read {{event.*}}). Each intent carries the event (event-trigger path).
  const statements: SqlStatement[] = intents.map((i) =>
    i.event
      ? buildEnrollmentInsertWithState(i.workspaceId, i.automationId, i.profileId, i.startNode, {
          event: i.event,
        })
      : buildEnrollmentInsert(i.workspaceId, i.automationId, i.profileId, i.startNode),
  );
  if (statements.length > 0) await deps.runInWorkspaceTx(row.workspace_id, statements);
  return { enrolled: intents.length, intents };
}

/**
 * Enroll a profile into the active PROFILE-trigger automations matched by a profile
 * CREATE or UPDATE (§9B) — the profile analogue of enrollFromEvent. Reads the
 * active automations in the profile's workspace, resolves each one's trigger node,
 * keeps only those whose kind='profile' AND whose configured profileChange matches
 * the change (created → {created, any}; updated → {updated, any}), then inserts the
 * enrollment(s) at the start node in ONE workspace-scoped tx. The ON CONFLICT
 * 'once' guard makes a re-save / re-import / re-run enroll at most once. No event
 * payload is persisted (event.* resolves safe-empty; the profile's data is read via
 * customer.* downstream). Tenant isolation: automations are read WHERE workspace_id=$1
 * and every write binds workspace_id at $1.
 */
export async function enrollFromProfileChange(
  deps: EnrollDeps,
  row: ProfileChangeRow,
): Promise<SimpleEnrollResult> {
  if (!row.workspace_id) throw new Error('enrollFromProfileChange: workspace_id is required');
  if (row.change !== 'created' && row.change !== 'updated') return { enrolled: 0, intents: [] };

  // Active automations in THIS workspace (the trigger kind / profileChange is resolved
  // from each definition; mirrors enrollFromEvent's read-small-set-resolve-in-code).
  const { rows: automationRows } = await deps.reader.query<AutomationRow>(
    `SELECT id, workspace_id, trigger_segment_id, trigger_on, definition
     FROM automations
     WHERE workspace_id = $1 AND status = 'active'`,
    [row.workspace_id],
  );

  const triggerRows: ProfileAutomationTriggerRow[] = [];
  for (const c of automationRows) {
    let trigger: TriggerNode;
    let startNode: string;
    try {
      validateAutomationDefinition(c.definition);
      const node = resolveStartNode(c.definition);
      if (node.type !== 'trigger' || node.kind !== 'profile') continue; // only profile triggers
      trigger = node;
      startNode = c.definition.startNode;
    } catch {
      continue; // skip an invalid definition rather than crash the hook
    }
    triggerRows.push({
      id: c.id,
      workspace_id: c.workspace_id,
      start_node: startNode,
      profileChange: trigger.profileChange ?? 'any',
    });
  }

  const intents = parseProfileEnrollmentTrigger(row, triggerRows);
  const statements: SqlStatement[] = intents.map((i) =>
    buildEnrollmentInsert(i.workspaceId, i.automationId, i.profileId, i.startNode),
  );
  if (statements.length > 0) await deps.runInWorkspaceTx(row.workspace_id, statements);
  return { enrolled: intents.length, intents };
}

/**
 * Resolve a automation's start node from its validated definition. THROWS if the
 * automation id resolves to nothing in `workspaceId` (cross-workspace / missing —
 * inv.2) or the definition is malformed. workspace_id bound at $1.
 */
async function loadStartNode(deps: EnrollDeps, workspaceId: string, automationId: string): Promise<string> {
  const { rows } = await deps.reader.query<{ definition: unknown }>(
    `SELECT definition FROM automations WHERE workspace_id = $1 AND id = $2 AND status = 'active'`,
    [workspaceId, automationId],
  );
  const def = rows[0]?.definition;
  if (def === undefined) throw new Error('enroll: automation not found in workspace');
  validateAutomationDefinition(def);
  resolveStartNode(def);
  return def.startNode;
}

/**
 * MANUAL/API enrollment of a SINGLE profile into a automation at its start node
 * (§9B). workspace-scoped (workspace_id at $1) + ON CONFLICT 'once'. The caller
 * (the endpoint) has already verified the profile belongs to the workspace.
 */
export async function enrollProfileManually(
  deps: EnrollDeps,
  args: { readonly workspaceId: string; readonly automationId: string; readonly profileId: string },
): Promise<SimpleEnrollResult> {
  const { workspaceId, automationId, profileId } = args;
  if (!workspaceId) throw new Error('enrollProfileManually: workspaceId is required');
  const startNode = await loadStartNode(deps, workspaceId, automationId);
  const intents: EnrollmentIntent[] = [{ workspaceId, automationId, profileId, startNode }];
  await deps.runInWorkspaceTx(workspaceId, [buildEnrollmentInsert(workspaceId, automationId, profileId, startNode)]);
  return { enrolled: 1, intents };
}

/**
 * MANUAL/API enrollment of a SEGMENT SNAPSHOT (§9B): resolve the segment's CURRENT
 * members (point-in-time) and enroll each at the automation's start node. Uses
 * buildResolveAudience so BOTH dynamic (source='evaluator') and manual
 * (source='manual') memberships are covered, workspace-scoped at $1. The snapshot
 * is point-in-time — later segment changes do NOT retroactively enroll. ON CONFLICT
 * 'once' makes a re-run insert no duplicates.
 */
export async function enrollSegmentSnapshot(
  deps: EnrollDeps,
  args: { readonly workspaceId: string; readonly automationId: string; readonly segmentId: string },
): Promise<SimpleEnrollResult> {
  const { workspaceId, automationId, segmentId } = args;
  if (!workspaceId) throw new Error('enrollSegmentSnapshot: workspaceId is required');
  const startNode = await loadStartNode(deps, workspaceId, automationId);
  const audience = buildResolveAudience(workspaceId, segmentId);
  const { rows } = await deps.reader.query<{ profile_id: string }>(audience.text, audience.values);
  const intents: EnrollmentIntent[] = rows.map((r) => ({
    workspaceId,
    automationId,
    profileId: r.profile_id,
    startNode,
  }));
  const statements = intents.map((i) =>
    buildEnrollmentInsert(i.workspaceId, i.automationId, i.profileId, i.startNode),
  );
  if (statements.length > 0) await deps.runInWorkspaceTx(workspaceId, statements);
  return { enrolled: intents.length, intents };
}
