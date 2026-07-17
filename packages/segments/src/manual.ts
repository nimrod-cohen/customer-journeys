// Manual segment membership (§1A, §8). A manual (kind='manual') segment is a
// static, user-curated group — hand-pick or CSV import. Membership changes ONLY
// via these builders; the evaluator never evaluates or touches it.
//
// These own source='manual' rows. Symmetry with the evaluator's discipline:
//   - addManualMembers writes source='manual'
//   - removeManualMembers deletes ONLY source='manual' rows (it never removes an
//     evaluator-owned membership)
// workspace_id is bound at $1 on every statement (CLAUDE.md inv. 1).

import { type SqlStatement } from './compile.js';
import { buildResolveAudience } from './statements.js';

/**
 * Add profiles to a manual segment (source='manual'). Idempotent
 * (ON CONFLICT DO NOTHING). profile_ids bound as ONE array param. Only profiles
 * in the same workspace are added (the `p.workspace_id = $1` join guard).
 */
export function addManualMembers(
  workspaceId: string,
  segmentId: string,
  profileIds: readonly string[],
): SqlStatement {
  return {
    text: `INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source)
           SELECT $2, p.id, $1, 'manual'
           FROM profiles p
           WHERE p.workspace_id = $1 AND p.id = ANY($3::uuid[])
           ON CONFLICT (segment_id, profile_id) DO NOTHING`,
    values: [workspaceId, segmentId, [...profileIds]],
  };
}

/**
 * Remove profiles from a manual segment. Constrained to source='manual' so an
 * evaluator-owned membership is never collaterally removed by a manual edit.
 */
export function removeManualMembers(
  workspaceId: string,
  segmentId: string,
  profileIds: readonly string[],
): SqlStatement {
  return {
    text: `DELETE FROM segment_memberships
           WHERE workspace_id = $1
             AND segment_id = $2
             AND source = 'manual'
             AND profile_id = ANY($3::uuid[])`,
    values: [workspaceId, segmentId, [...profileIds]],
  };
}

/**
 * Resolve a segment's audience (all member profile ids, both sources) — used by
 * broadcasts/automations. Thin re-export of `buildResolveAudience` so callers can
 * import audience resolution from the manual module too. workspace_id at $1.
 */
export function resolveAudience(workspaceId: string, segmentId: string): SqlStatement {
  return buildResolveAudience(workspaceId, segmentId);
}
