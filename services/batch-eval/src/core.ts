// Batch segment evaluation core (§8 dynamic_batch, §17 phase 5). Pure logic +
// an injected orchestrator. The batch-eval Lambda is EventBridge-scheduled and
// sweeps each workspace's active dynamic_batch segments periodically: for each
// segment, match the WHOLE workspace, diff against current evaluator membership,
// and apply entered/exited — all workspace-scoped (workspace_id bound at $1).
//
// Reuses the @cdp/segments builders so the compiler, source='evaluator'
// discipline, and array-bound writes are identical to the realtime path. The
// evaluator runs as the service role (bypasses RLS) → in-code scoping is the
// guard.

import {
  selectActiveBatchSegments,
  selectCampaignTriggerSegments,
  isTimeSensitive,
  buildSegmentMatch,
  selectEvaluatorMembership,
  buildInsertMemberships,
  buildDeleteMemberships,
  buildChangeLog,
  diffMembership,
  type SqlStatement,
  type AstNode,
  type SegmentRow,
} from '@cdp/segments';

/** A read that returns rows (SELECT). */
export interface QueryFn {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Run a set of statements inside ONE workspace-scoped transaction. */
export type RunInWorkspaceTx = (
  workspaceId: string,
  statements: readonly SqlStatement[],
) => Promise<void>;

/** Injected dependencies for the batch sweep. */
export interface BatchEvalDeps {
  readonly reader: QueryFn;
  readonly runInWorkspaceTx: RunInWorkspaceTx;
}

/** Per-segment outcome of a batch sweep (counts for logging/tests). */
export interface BatchSegmentResult {
  readonly segmentId: string;
  readonly entered: number;
  readonly exited: number;
}

/** The outcome of sweeping one workspace. */
export interface BatchEvalResult {
  readonly workspaceId: string;
  readonly segments: BatchSegmentResult[];
}

function asAst(value: unknown): AstNode | null {
  if (value === null || value === undefined) return null;
  return value as AstNode;
}

/**
 * Plan the workspace-scoped read that lists this workspace's active
 * dynamic_batch segments. Pure (workspace_id bound at $1, excludes manual).
 */
export function planBatchEval(workspaceId: string): SqlStatement {
  return selectActiveBatchSegments(workspaceId);
}

/**
 * Build the apply statements (membership + change_log) for one segment's diff.
 * Pure: given who entered/exited, return the ordered statements. Empty diffs
 * yield no statements. source='evaluator' is forced by the builders.
 */
export function planBatchSegmentApply(
  workspaceId: string,
  segmentId: string,
  entered: readonly string[],
  exited: readonly string[],
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  if (entered.length > 0) {
    statements.push(buildInsertMemberships(workspaceId, segmentId, entered));
    statements.push(buildChangeLog(workspaceId, segmentId, entered, 'entered'));
  }
  if (exited.length > 0) {
    statements.push(buildDeleteMemberships(workspaceId, segmentId, exited));
    statements.push(buildChangeLog(workspaceId, segmentId, exited, 'exited'));
  }
  return statements;
}

/**
 * Sweep ALL active dynamic_batch segments for one workspace: match the whole
 * workspace, diff vs current evaluator membership, apply per segment in a single
 * workspace-scoped tx. Returns per-segment entered/exited counts.
 */
export async function runBatchEvalForWorkspace(
  deps: BatchEvalDeps,
  workspaceId: string,
): Promise<BatchEvalResult> {
  const segQ = planBatchEval(workspaceId);
  const segRes = await deps.reader.query(segQ.text, segQ.values);
  const segments = segRes.rows as unknown as SegmentRow[];

  const results: BatchSegmentResult[] = [];

  for (const seg of segments) {
    // 1. who matches now (whole-workspace, no profile filter)
    const matchQ = buildSegmentMatch(workspaceId, asAst(seg.definition));
    const matched = (await deps.reader.query(matchQ.text, matchQ.values)).rows.map(
      (r) => r.id as string,
    );
    // 2. current evaluator membership
    const memQ = selectEvaluatorMembership(workspaceId, seg.id);
    const current = (await deps.reader.query(memQ.text, memQ.values)).rows.map(
      (r) => r.profile_id as string,
    );
    // 3. diff
    const { entered, exited } = diffMembership(current, matched);
    // 4. apply (one tx per segment keeps a single segment's failure isolated)
    const statements = planBatchSegmentApply(workspaceId, seg.id, entered, exited);
    if (statements.length > 0) {
      await deps.runInWorkspaceTx(workspaceId, statements);
    }
    results.push({ segmentId: seg.id, entered: entered.length, exited: exited.length });
  }

  return { workspaceId, segments: results };
}

/** Plan the read that lists campaign-trigger segments for a workspace (sweep scope). */
export function planCampaignTimeSweep(workspaceId: string): SqlStatement {
  return selectCampaignTriggerSegments(workspaceId);
}

/**
 * Re-evaluate the TIME-SENSITIVE segments that trigger active campaigns in one
 * workspace and emit their membership transitions. A time-windowed segment's
 * membership drifts with the clock (a profile ages out with no event), so it must
 * be re-checked periodically: match the whole workspace, diff vs current evaluator
 * membership, apply membership + segment_change_log (entered/exited) per segment in
 * its own tx. The emitted change_log is what drives time-based campaign enter/exit.
 * Non-time-sensitive trigger segments are skipped — the realtime processor owns
 * those (they change only on data changes). Same builders/scoping as the batch sweep.
 */
export async function runCampaignTimeSweepForWorkspace(
  deps: BatchEvalDeps,
  workspaceId: string,
): Promise<BatchEvalResult> {
  const segQ = planCampaignTimeSweep(workspaceId);
  const segRes = await deps.reader.query(segQ.text, segQ.values);
  const segments = (segRes.rows as unknown as SegmentRow[]).filter((s) => isTimeSensitive(asAst(s.definition)));

  const results: BatchSegmentResult[] = [];
  for (const seg of segments) {
    const matchQ = buildSegmentMatch(workspaceId, asAst(seg.definition));
    const matched = (await deps.reader.query(matchQ.text, matchQ.values)).rows.map((r) => r.id as string);
    const memQ = selectEvaluatorMembership(workspaceId, seg.id);
    const current = (await deps.reader.query(memQ.text, memQ.values)).rows.map((r) => r.profile_id as string);
    const { entered, exited } = diffMembership(current, matched);
    const statements = planBatchSegmentApply(workspaceId, seg.id, entered, exited);
    if (statements.length > 0) await deps.runInWorkspaceTx(workspaceId, statements);
    results.push({ segmentId: seg.id, entered: entered.length, exited: exited.length });
  }
  return { workspaceId, segments: results };
}
