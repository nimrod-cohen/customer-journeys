// Lambda entrypoint for the processor service (§7). Wires production deps into
// the thin SQS-FIFO handler. Pure logic lives in ./core.ts; all I/O in ./deps.ts.
import { makeProcessorHandler, type SqsEvent } from './handler.js';
import { makeProdDeps } from './deps.js';

export {
  parseProcessorMessage,
  buildEventInsert,
  buildProcessorProfileUpsert,
  planProcessing,
  type SqlStatement,
  type ProcessingPlan,
} from './core.js';
export { makeProcessorHandler } from './handler.js';
export type { ProcessorDeps, SqsEvent, SqsRecord, BatchResponse } from './handler.js';
export { runPlanInWorkspaceTx } from './deps.js';

let cached: ReturnType<typeof makeProcessorHandler> | undefined;

export async function handler(event: SqsEvent) {
  if (!cached) cached = makeProcessorHandler(makeProdDeps());
  return cached(event);
}
