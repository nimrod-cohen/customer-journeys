// Broadcast Lambda — thin handlers (§9A). Two entry points:
//   - onSendNow: triggered when a broadcast is sent immediately (e.g. an
//     API/SQS event carrying { broadcast_id }).
//   - onScheduledSweep: an EventBridge schedule that finds scheduled broadcasts
//     whose scheduled_at has arrived and runs each.
// All logic lives in send.ts / core.ts; these handlers just wire deps and never
// throw (a failure in one broadcast must not abort the sweep / poison the queue).
import { buildDueScheduledBroadcastsQuery } from './core.js';
import { runBroadcast, type BroadcastDeps } from './send.js';

/** Build the send-now handler. Accepts an explicit broadcast id. */
export function makeSendNowHandler(deps: BroadcastDeps) {
  return async function onSendNow(broadcastId: string): Promise<void> {
    try {
      await runBroadcast(deps, broadcastId);
    } catch {
      /* never throw out of the handler; the broadcast stays re-runnable */
    }
  };
}

/** Build the EventBridge scheduled-sweep handler. */
export function makeScheduledSweepHandler(deps: BroadcastDeps) {
  return async function onScheduledSweep(): Promise<void> {
    let ids: string[] = [];
    try {
      const q = buildDueScheduledBroadcastsQuery(deps.now());
      const { rows } = await deps.reader.query<{ id: string }>(q.text, q.values);
      ids = rows.map((r) => r.id);
    } catch {
      return; // could not read the due set; the next sweep retries
    }
    for (const id of ids) {
      try {
        await runBroadcast(deps, id);
      } catch {
        /* isolate failures: one bad broadcast must not abort the sweep */
      }
    }
  };
}
