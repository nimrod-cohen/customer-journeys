// Realtime segment evaluation for a single changed profile (§8, §7 step 4/5).
//
// Called by the Processor AFTER profile + feature upserts (so it reads
// POST-update features). For the CHANGED profile only, for each active
// dynamic_realtime segment:
//   1. does the profile match the segment's rule NOW?  (buildSegmentMatch with
//      `AND p.id = $profile`)
//   2. is the profile currently an evaluator member of the segment?
//   3. diff → entered (matched & not member) / exited (member & not matched)
//   4. apply membership insert/delete + change_log in ONE workspace-scoped tx.
//
// kind='manual' segments are NEVER selected here, so the evaluator never touches
// manual membership. The evaluator runs as the service role (bypasses RLS); every
// statement binds workspace_id at $1 — isolation is in-code (CLAUDE.md inv. 1+6).

import { type SqlStatement, type AstNode } from './compile.js';
import {
  selectActiveRealtimeSegments,
  buildSegmentMatch,
  buildInsertMemberships,
  buildDeleteMemberships,
  buildChangeLog,
  type SegmentRow,
} from './statements.js';

/** A read that returns rows (SELECT). */
export interface QueryFn {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Run a set of statements inside ONE workspace-scoped transaction. */
export type RunInWorkspaceTx = (
  workspaceId: string,
  statements: readonly SqlStatement[],
) => Promise<void>;

/** Injected dependencies for the realtime evaluator. */
export interface EvaluateDeps {
  /** A query runner for the reads (service-role pool / client). */
  readonly reader: QueryFn;
  /** Apply membership mutations atomically, workspace-scoped. */
  readonly runInWorkspaceTx: RunInWorkspaceTx;
}

/** What changed for one segment when a single profile was re-evaluated. */
export interface SegmentDelta {
  readonly segmentId: string;
  readonly action: 'entered' | 'exited' | 'none';
}

/** The outcome of re-evaluating all realtime segments for one profile. */
export interface RealtimeEvalResult {
  readonly workspaceId: string;
  readonly profileId: string;
  readonly deltas: SegmentDelta[];
}

function asAst(value: unknown): AstNode | null {
  if (value === null || value === undefined) return null;
  return value as AstNode;
}

/**
 * Build the per-segment statements (membership + change_log) for a single
 * profile's transition. Pure: given whether the profile matches now and whether
 * it is currently a member, return the ordered statements to apply (empty when
 * nothing changes). Exported so it can be unit-tested without a DB.
 */
export function planProfileSegmentTransition(
  workspaceId: string,
  segmentId: string,
  profileId: string,
  matchesNow: boolean,
  isMember: boolean,
): { statements: SqlStatement[]; action: SegmentDelta['action'] } {
  if (matchesNow && !isMember) {
    return {
      action: 'entered',
      statements: [
        buildInsertMemberships(workspaceId, segmentId, [profileId]),
        buildChangeLog(workspaceId, segmentId, [profileId], 'entered'),
      ],
    };
  }
  if (!matchesNow && isMember) {
    return {
      action: 'exited',
      statements: [
        buildDeleteMemberships(workspaceId, segmentId, [profileId]),
        buildChangeLog(workspaceId, segmentId, [profileId], 'exited'),
      ],
    };
  }
  return { action: 'none', statements: [] };
}

async function profileMatchesSegment(
  deps: EvaluateDeps,
  workspaceId: string,
  seg: SegmentRow,
  profileId: string,
): Promise<boolean> {
  const match = buildSegmentMatch(workspaceId, asAst(seg.definition), profileId);
  const res = await deps.reader.query(match.text, match.values);
  return res.rows.length > 0;
}

async function profileIsMember(
  deps: EvaluateDeps,
  workspaceId: string,
  segmentId: string,
  profileId: string,
): Promise<boolean> {
  // Evaluator-owned membership only (source='evaluator').
  const res = await deps.reader.query(
    `SELECT 1 FROM segment_memberships
     WHERE workspace_id = $1 AND segment_id = $2 AND profile_id = $3 AND source = 'evaluator'`,
    [workspaceId, segmentId, profileId],
  );
  return res.rows.length > 0;
}

/**
 * Re-evaluate every active dynamic_realtime segment for the CHANGED profile and
 * apply the resulting entered/exited transitions in a single workspace-scoped
 * transaction. Returns the per-segment deltas (for logging/tests).
 *
 * Cross-workspace safety: all reads + writes bind workspace_id at $1 and the
 * match query scopes `p.workspace_id = $1 AND p.id = $profile`, so a profile in
 * another workspace can never match or be affected.
 */
export async function evaluateRealtimeSegmentsForProfile(
  deps: EvaluateDeps,
  workspaceId: string,
  profileId: string,
): Promise<RealtimeEvalResult> {
  const segQ = selectActiveRealtimeSegments(workspaceId);
  const segRes = await deps.reader.query(segQ.text, segQ.values);
  const segments = segRes.rows as unknown as SegmentRow[];

  const allStatements: SqlStatement[] = [];
  const deltas: SegmentDelta[] = [];

  for (const seg of segments) {
    const [matchesNow, isMember] = await Promise.all([
      profileMatchesSegment(deps, workspaceId, seg, profileId),
      profileIsMember(deps, workspaceId, seg.id, profileId),
    ]);
    const { statements, action } = planProfileSegmentTransition(
      workspaceId,
      seg.id,
      profileId,
      matchesNow,
      isMember,
    );
    if (statements.length > 0) allStatements.push(...statements);
    deltas.push({ segmentId: seg.id, action });
  }

  if (allStatements.length > 0) {
    await deps.runInWorkspaceTx(workspaceId, allStatements);
  }
  return { workspaceId, profileId, deltas };
}
