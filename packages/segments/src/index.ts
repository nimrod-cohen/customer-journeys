// @cdp/segments — rule AST + SQL compiler (mandatory workspace_id) + the
// realtime/batch evaluator builders and manual-segment membership.
// See CDP-BUILD-SPEC.md §8, §16A, CLAUDE.md invariant 6.

export {
  compileWhere,
  validateAst,
  resolveField,
  resolveOperator,
  SCALAR_FEATURE_FIELDS,
  SCALAR_PROFILE_FIELDS,
  OPERATORS,
  type SqlStatement,
  type AstNode,
  type GroupNode,
  type ConditionNode,
  type EventNode,
  type OperatorToken,
  type ResolvedField,
} from './compile.js';

export { diffMembership, type MembershipDiff } from './diff.js';

export {
  selectActiveRealtimeSegments,
  selectActiveBatchSegments,
  buildSegmentMatch,
  selectEvaluatorMembership,
  buildInsertMemberships,
  buildDeleteMemberships,
  buildChangeLog,
  buildResolveAudience,
  type MembershipSource,
  type SegmentRow,
} from './statements.js';

export {
  evaluateRealtimeSegmentsForProfile,
  planProfileSegmentTransition,
  type EvaluateDeps,
  type QueryFn,
  type RunInWorkspaceTx,
  type SegmentDelta,
  type RealtimeEvalResult,
} from './evaluate.js';

export { addManualMembers, removeManualMembers, resolveAudience } from './manual.js';
