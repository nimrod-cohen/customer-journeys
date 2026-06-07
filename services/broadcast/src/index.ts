// Lambda entrypoint for the broadcast service (§9A). Wires production deps into
// the thin handlers. Pure logic lives in ./core.ts; orchestration in ./send.ts;
// all I/O in ./deps.ts.
import { makeSendNowHandler, makeScheduledSweepHandler } from './handler.js';
import { makeProdDeps } from './deps.js';

export {
  buildBroadcastDedupeKey,
  buildBroadcastOutboxInsert,
  buildBroadcastStatusUpdate,
  buildDispatchEnqueueMessage,
  buildDueScheduledBroadcastsQuery,
  chunk,
  isScheduleDue,
  isValidBroadcastTransition,
  type BroadcastStatus,
  type SqlStatement,
} from './core.js';
export {
  runBroadcast,
  type BroadcastDeps,
  type Reader,
  type SqsSender,
  type RunBroadcastResult,
} from './send.js';
export { makeSendNowHandler, makeScheduledSweepHandler } from './handler.js';
export { runStatementsInWorkspaceTx, makeProdDeps, type PoolLike } from './deps.js';

let sendNow: ReturnType<typeof makeSendNowHandler> | undefined;
let sweep: ReturnType<typeof makeScheduledSweepHandler> | undefined;

/** Send-now Lambda handler: an event carrying a broadcast id. */
export async function sendNowHandler(event: { broadcast_id: string }): Promise<void> {
  if (!sendNow) sendNow = makeSendNowHandler(makeProdDeps());
  return sendNow(event.broadcast_id);
}

/** EventBridge scheduled-sweep Lambda handler (no payload). */
export async function scheduledSweepHandler(): Promise<void> {
  if (!sweep) sweep = makeScheduledSweepHandler(makeProdDeps());
  return sweep();
}
