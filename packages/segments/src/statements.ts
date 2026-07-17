// Segment write/read statement builders (§6, §8). Every statement binds
// workspace_id at $1 (CLAUDE.md invariant 1 + 6) — the evaluator runs as the
// service role and BYPASSES RLS, so in-code scoping is the only guard.
//
// source discipline (AC "Segments"): the EVALUATOR only ever writes/deletes rows
// with source='evaluator'. It NEVER touches source='manual' rows — every
// evaluator membership delete carries `AND source = 'evaluator'`, and inserts set
// source='evaluator'. Manual membership is the user's; the evaluator leaves it
// alone. The dedicated manual builders (manual.ts) own source='manual'.

import { compileWhere, type SqlStatement, type AstNode } from './compile.js';

/** Source tag distinguishing evaluator-written vs user-curated memberships (§6). */
export type MembershipSource = 'evaluator' | 'manual';

/** A segment row (the columns the evaluator needs), as read from the DB. */
export interface SegmentRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly definition: AstNode | null;
  readonly kind: string;
}

/**
 * Select active dynamic_realtime segments for a workspace (excludes manual).
 * The Processor reads these on each profile change to re-evaluate them.
 */
export function selectActiveRealtimeSegments(workspaceId: string): SqlStatement {
  return {
    text: `SELECT id, workspace_id, definition, kind
           FROM segments
           WHERE workspace_id = $1
             AND status = 'active'
             AND kind = 'dynamic_realtime'`,
    values: [workspaceId],
  };
}

/**
 * Select active dynamic_batch segments for a workspace (excludes manual).
 * The batch-eval sweep reads these per workspace on a schedule.
 */
export function selectActiveBatchSegments(workspaceId: string): SqlStatement {
  return {
    text: `SELECT id, workspace_id, definition, kind
           FROM segments
           WHERE workspace_id = $1
             AND status = 'active'
             AND kind = 'dynamic_batch'`,
    values: [workspaceId],
  };
}

/**
 * Select active dynamic_realtime segments that are the enrollment trigger of an
 * active automation (automations.trigger_segment_id). These are the segments the
 * scheduled sweep must re-evaluate over time so enter/exit transitions fire for
 * automations — the rest are left to the realtime processor. workspace_id at $1.
 */
export function selectAutomationTriggerSegments(workspaceId: string): SqlStatement {
  return {
    text: `SELECT s.id, s.workspace_id, s.definition, s.kind
           FROM segments s
           WHERE s.workspace_id = $1
             AND s.status = 'active'
             AND s.kind = 'dynamic_realtime'
             AND EXISTS (
               SELECT 1 FROM automations c
               WHERE c.workspace_id = $1 AND c.status = 'active' AND c.trigger_segment_id = s.id
             )`,
    values: [workspaceId],
  };
}

/**
 * Build the "who matches this segment" query, optionally scoped to a SINGLE
 * changed profile (realtime path) via `AND p.id = $profile`. Reuses the §8
 * compiler so workspace_id is structurally $1 and the rule is fully
 * parameterized. Returns profile ids.
 *
 * @param onlyProfileId when set, restricts evaluation to that one profile (the
 *   realtime path evaluates just the CHANGED profile). When omitted, evaluates
 *   the whole workspace (the batch path).
 */
export function buildSegmentMatch(
  workspaceId: string,
  ast: AstNode | null,
  onlyProfileId?: string,
): SqlStatement {
  const where = compileWhere(workspaceId, ast);
  // compileWhere bound workspace_id at $1; append the optional profile filter as
  // the next placeholder so we never collide with the compiler's params.
  const values = [...where.values];
  let profileClause = '';
  if (onlyProfileId !== undefined) {
    values.push(onlyProfileId);
    profileClause = ` AND p.id = $${values.length}`;
  }
  return {
    text: `SELECT p.id
           FROM profiles p
           LEFT JOIN profile_features pf ON pf.profile_id = p.id
           WHERE ${where.text}${profileClause}`,
    values,
  };
}

/**
 * Select the current evaluator-owned membership profile ids for a segment.
 * Only source='evaluator' rows — manual rows are out of the evaluator's scope.
 */
export function selectEvaluatorMembership(workspaceId: string, segmentId: string): SqlStatement {
  return {
    text: `SELECT profile_id
           FROM segment_memberships
           WHERE workspace_id = $1
             AND segment_id = $2
             AND source = 'evaluator'`,
    values: [workspaceId, segmentId],
  };
}

/**
 * Insert evaluator memberships for the profiles that ENTERED a segment.
 * source='evaluator' is forced. ON CONFLICT DO NOTHING keeps it idempotent (a
 * re-run won't error on an already-present row). profile_ids bound as ONE array
 * param (= ANY) so the statement shape is fixed regardless of batch size.
 */
export function buildInsertMemberships(
  workspaceId: string,
  segmentId: string,
  profileIds: readonly string[],
): SqlStatement {
  return {
    text: `INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source)
           SELECT $2, p.id, $1, 'evaluator'
           FROM profiles p
           WHERE p.workspace_id = $1 AND p.id = ANY($3::uuid[])
           ON CONFLICT (segment_id, profile_id) DO NOTHING`,
    values: [workspaceId, segmentId, [...profileIds]],
  };
}

/**
 * Delete evaluator memberships for the profiles that EXITED a segment.
 * Constrained to source='evaluator' so a manual membership is NEVER removed by
 * the evaluator (AC "manual segments ... not touched by the evaluator").
 */
export function buildDeleteMemberships(
  workspaceId: string,
  segmentId: string,
  profileIds: readonly string[],
): SqlStatement {
  return {
    text: `DELETE FROM segment_memberships
           WHERE workspace_id = $1
             AND segment_id = $2
             AND source = 'evaluator'
             AND profile_id = ANY($3::uuid[])`,
    values: [workspaceId, segmentId, [...profileIds]],
  };
}

/**
 * Append segment_change_log rows for a batch of profiles with a single action.
 * profile_ids bound as ONE array param. workspace_id at $1.
 */
export function buildChangeLog(
  workspaceId: string,
  segmentId: string,
  profileIds: readonly string[],
  action: 'entered' | 'exited',
): SqlStatement {
  return {
    text: `INSERT INTO segment_change_log (workspace_id, segment_id, profile_id, action)
           SELECT $1, $2, p.id, $4
           FROM profiles p
           WHERE p.workspace_id = $1 AND p.id = ANY($3::uuid[])`,
    values: [workspaceId, segmentId, [...profileIds], action],
  };
}

/**
 * Resolve a segment's current audience (member profile ids) for broadcasts /
 * automations (§9A). Works for BOTH kinds — dynamic memberships (source='evaluator')
 * and manual memberships (source='manual') live in the same table, so this
 * returns ALL members regardless of source. workspace_id at $1.
 */
export function buildResolveAudience(workspaceId: string, segmentId: string): SqlStatement {
  return {
    text: `SELECT profile_id
           FROM segment_memberships
           WHERE workspace_id = $1
             AND segment_id = $2`,
    values: [workspaceId, segmentId],
  };
}
