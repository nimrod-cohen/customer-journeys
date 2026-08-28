// Lambda entrypoint for the feedback service (§10). Wires production deps into
// the thin SNS handler. Pure logic lives in ./core.ts; orchestration in
// ./feedback.ts; all I/O in ./deps.ts.
import { makeFeedbackHandler, type SnsEvent } from './handler.js';
import { makeProdDeps } from './deps.js';

export {
  classifySesEvent,
  resolveWorkspaceRef,
  shouldMarkPermanentSoftBounce,
  PERMANENT_SOFT_BOUNCE_DAYS,
  PERMANENT_SOFT_BOUNCE,
  decideReputation,
  BOUNCE_RATE_CRITICAL,
  COMPLAINT_RATE_CRITICAL,
  MIN_SENT_FOR_RATE,
  buildEmailEventInsert,
  buildSuppressionUpsert,
  buildGlobalHardBounceUpsert,
  buildProfileEmailStatusUpdate,
  buildSoftBounceDayCountQuery,
  buildReputationRateQuery,
  buildWorkspaceSuspend,
  type SqlStatement,
  type SesNotification,
  type ClassifiedEvent,
  type FeedbackCategory,
  type EmailEventType,
  type WorkspaceRef,
  type ReputationCounts,
  type ReputationDecision,
  type EmailEventRow,
} from './core.js';
export {
  buildFeedbackPlan,
  handleNotification,
  type FeedbackDeps,
  type FeedbackResult,
  type FeedbackPlanInput,
  type Reader,
} from './feedback.js';
export {
  makeFeedbackHandler,
  type SnsEvent,
  type SnsRecord,
  type BatchResponse,
} from './handler.js';
export { makeProdDeps, runFeedbackStatementsInTx, type PoolLike } from './deps.js';

let cached: ReturnType<typeof makeFeedbackHandler> | undefined;

export async function handler(event: SnsEvent) {
  if (!cached) cached = makeFeedbackHandler(makeProdDeps());
  return cached(event);
}

// Inbound SMTP bounce (DSN) and spam-report (ARF) parsing — the self-hosted twin
// of classifySesEvent. Both converge on ClassifiedEvent so the suppression and
// email_events builders above are shared, not duplicated.
export {
  parseBounceMessage,
  parseDeliveryStatus,
  classifyDeliveryStatus,
  classifyInboundReport,
  parseHeaders,
  splitMessage,
  type DsnReport,
  type ParsedBounceMessage,
} from './dsn.js';
