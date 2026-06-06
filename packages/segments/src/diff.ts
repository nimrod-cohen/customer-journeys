// Membership diff (§8, AC "Segmentation"): given the CURRENT membership set and
// the freshly-MATCHED set for a segment, compute who entered and who exited.
//
// Enter-once / exit-once, deduped:
//   - entered = matched \ current (a profile newly matching that wasn't a member)
//   - exited  = current \ matched (a profile that was a member but no longer matches)
// A profile present in both is unchanged (no churn). Duplicate ids on either side
// collapse (Set semantics), so a profile can never be entered or exited twice in
// one diff. Output order follows first-seen order of the input arrays for
// determinism.

/** The result of diffing a membership set against a freshly-matched set. */
export interface MembershipDiff {
  /** Profile ids newly matching the segment (to ADD + log 'entered'). */
  readonly entered: string[];
  /** Profile ids that were members but no longer match (to REMOVE + log 'exited'). */
  readonly exited: string[];
}

/**
 * Diff current membership against the matched set.
 * @param currentIds profile ids currently in `segment_memberships` for the segment.
 * @param matchedIds profile ids that match the segment's rule now.
 */
export function diffMembership(
  currentIds: Iterable<string>,
  matchedIds: Iterable<string>,
): MembershipDiff {
  const current = new Set<string>();
  for (const id of currentIds) current.add(id);
  const matched = new Set<string>();
  for (const id of matchedIds) matched.add(id);

  const entered: string[] = [];
  for (const id of matched) {
    if (!current.has(id)) entered.push(id);
  }
  const exited: string[] = [];
  for (const id of current) {
    if (!matched.has(id)) exited.push(id);
  }
  return { entered, exited };
}
