// Lambda entrypoint for the automation-runner service (§9B). Wires production deps
// into the thin scheduled-sweep handler. Pure logic lives in ./core.ts + ./dsl.ts;
// orchestration in ./run.ts (per-enrollment tick) + ./enroll.ts (enrollment);
// all I/O in ./deps.ts.
import { makeScheduledSweepHandler } from './handler.js';
import { makeProdDeps } from './deps.js';

export {
  type Node,
  type TriggerNode,
  type ProfileChange,
  type WaitNode,
  type ConditionNode,
  type ActionNode,
  type WebhookAction,
  type WebhookMethod,
  type HourOfDayWindowNode,
  type ExitNode,
  type AutomationDefinition,
  type WaitDelaySeconds,
  validateAutomationDefinition,
  resolveStartNode,
  findNode,
  collectSendNodeEnvelopeGaps,
  type ValueSpec,
  type SendNodeEnvelope,
  type SendNodeEnvelopeGap,
} from './dsl.js';

export {
  processNode,
  computeWaitNextRunAt,
  parseIso8601DurationSeconds,
  isWaitElapsed,
  buildBranchMatchQuery,
  rewriteTriggerEventLeaves,
  evaluateBranch,
  decideReenrollment,
  DEFAULT_REENROLLMENT_POLICY,
  parseEnrollmentTrigger,
  parseEventEnrollmentTrigger,
  parseProfileEnrollmentTrigger,
  evaluateEventPayloadFilter,
  buildEnrollmentInsert,
  parseKeepWhileInCancellations,
  buildEnrollmentCancel,
  buildSweepQuery,
  buildEnrollmentClaim,
  buildAdvanceEnrollment,
  buildAutomationDedupeKey,
  buildAutomationOutboxInsert,
  buildSetAttribute,
  buildSetJourney,
  isEnrollableAutomationStatus,
  nextLifecycle,
  automationCountsShape,
  type AutomationStatus,
  type AutomationLifecycleAction,
  type AutomationLifecycleResult,
  type AutomationEnrollmentCounts,
  type AutomationCountRow,
  type SqlStatement,
  type SideEffect,
  type EnrollmentState,
  type ProcessResult,
  type ReenrollmentPolicy,
  type Arrival,
  type SegmentChangeLogRow,
  type EventRow,
  type EventAutomationTriggerRow,
  type ProfileChangeRow,
  type ProfileAutomationTriggerRow,
  type ProfileChangeKind,
  type AutomationTriggerRow,
  type AutomationKeepRow,
  type CancelIntent,
  type EnrollmentIntent,
} from './core.js';

export {
  enrollFromSegmentChange,
  enrollFromEvent,
  enrollFromProfileChange,
  enrollProfileManually,
  enrollSegmentSnapshot,
  type EnrollDeps,
  type EnrollResult,
  type SimpleEnrollResult,
  type Reader as EnrollReader,
} from './enroll.js';

export {
  runEnrollment,
  buildDispatchEnqueueMessage,
  MAX_STEPS_PER_TICK,
  type RunDeps,
  type Reader,
  type TxClient,
  type SqsSender,
  type RunEnrollmentResult,
} from './run.js';

export { makeScheduledSweepHandler } from './handler.js';
export {
  runStatementsInWorkspaceTx,
  withWorkspaceTx,
  makeProdDeps,
  type PoolLike,
} from './deps.js';

let sweep: ReturnType<typeof makeScheduledSweepHandler> | undefined;

/** EventBridge scheduled-sweep Lambda handler (no payload). */
export async function scheduledSweepHandler(): Promise<void> {
  if (!sweep) sweep = makeScheduledSweepHandler(makeProdDeps());
  return sweep();
}
