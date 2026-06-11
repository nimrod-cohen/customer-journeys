// Lambda entrypoint for the batch-eval service (§8). Wires production deps into
// the scheduled sweep handler. Pure logic in ./core.ts; all I/O in ./deps.ts.
import { makeBatchEvalHandler } from './handler.js';
import { makeProdDeps } from './deps.js';

export {
  planBatchEval,
  planBatchSegmentApply,
  runBatchEvalForWorkspace,
  planCampaignTimeSweep,
  runCampaignTimeSweepForWorkspace,
  type BatchEvalDeps,
  type BatchEvalResult,
  type BatchSegmentResult,
  type QueryFn,
  type RunInWorkspaceTx,
} from './core.js';
export {
  makeBatchEvalHandler,
  type BatchEvalHandlerDeps,
  type BatchEvalSweepResult,
} from './handler.js';
export { runStatementsInWorkspaceTx } from './deps.js';

let cached: ReturnType<typeof makeBatchEvalHandler> | undefined;

export async function handler() {
  if (!cached) cached = makeBatchEvalHandler(makeProdDeps());
  return cached();
}
