// Lambda entrypoint for the dispatcher service (§9). Wires production deps into
// the thin SQS handler. Pure logic lives in ./core.ts; orchestration in
// ./dispatch.ts; all I/O in ./deps.ts.
import { makeDispatcherHandler, type SqsEvent } from './handler.js';
import { makeProdDeps } from './deps.js';

export {
  decideDispatch,
  isOverCap,
  windowStart,
  isInQuietHours,
  nextSendableAt,
  renderTemplateBody,
  buildSendEmailInput,
  buildChannelMessage,
  resolveTextRecipient,
  buildRecentSendCountQuery,
  buildIsSuppressedQuery,
  buildMessagesLogInsert,
  buildMessagesLogFailure,
  buildUsageCounterIncrement,
  buildOutboxClaim,
  buildOutboxMarkSent,
  parseOutboxIdFromSqsRecord,
  type DispatchContext,
  type DispatchDecision,
  type QuietSchedule,
  type QuietWindow,
  type FrequencyCap,
  type GuardStage,
  type SqlStatement,
} from './core.js';
export {
  dispatchOutbox,
  type DispatchDeps,
  type DispatchOutcome,
  type Reader,
} from './dispatch.js';
export {
  makeDispatcherHandler,
  MAX_ATTEMPTS,
  type HandlerDeps,
  type SqsEvent,
  type SqsRecord,
  type BatchResponse,
} from './handler.js';
export { runStatementsInWorkspaceTx, makeProdDeps, channelConfigForWorkspace, type PoolLike } from './deps.js';

let cached: ReturnType<typeof makeDispatcherHandler> | undefined;

export async function handler(event: SqsEvent) {
  if (!cached) cached = makeDispatcherHandler(makeProdDeps());
  return cached(event);
}
