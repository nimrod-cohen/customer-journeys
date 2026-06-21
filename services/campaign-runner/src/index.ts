// Lambda entrypoint for the campaign-runner service (§9B). Wires production deps
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
  type CampaignDefinition,
  type WaitDelaySeconds,
  validateCampaignDefinition,
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
  buildCampaignDedupeKey,
  buildCampaignOutboxInsert,
  buildSetAttribute,
  isEnrollableCampaignStatus,
  nextLifecycle,
  campaignCountsShape,
  type CampaignStatus,
  type CampaignLifecycleAction,
  type CampaignLifecycleResult,
  type CampaignEnrollmentCounts,
  type CampaignCountRow,
  type SqlStatement,
  type SideEffect,
  type EnrollmentState,
  type ProcessResult,
  type ReenrollmentPolicy,
  type Arrival,
  type SegmentChangeLogRow,
  type EventRow,
  type EventCampaignTriggerRow,
  type ProfileChangeRow,
  type ProfileCampaignTriggerRow,
  type ProfileChangeKind,
  type CampaignTriggerRow,
  type CampaignKeepRow,
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
