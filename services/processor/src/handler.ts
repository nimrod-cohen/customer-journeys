// Processor Lambda — thin SQS-FIFO handler (§7).
//
// Per record: parseProcessorMessage → planProcessing → run the plan in a
// WORKSPACE-SCOPED transaction (injected). On ANY failure, the record's id is
// added to `batchItemFailures` (partial batch response) — it is NOT acked, so
// SQS redelivers and eventually routes to the DLQ (CLAUDE.md invariant 4). A
// successful record is omitted from the failure list. We never assert "SQS
// delivered in order" — only that our code is idempotent + order-convergent.
import { parseProcessorMessage, planProcessing, type ProcessingPlan } from './core.js';

/** A single SQS record (the bits we use). */
export interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
}

export interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

/** SQS partial-batch-failure response shape. */
export interface BatchResponse {
  readonly batchItemFailures: readonly { itemIdentifier: string }[];
}

/** Injected dependencies — real implementation lives in `deps.ts`. */
export interface ProcessorDeps {
  /** Apply a plan inside a single workspace-scoped DB transaction. */
  runInWorkspaceTx(workspaceId: string, plan: ProcessingPlan): Promise<void>;
}

/** Build the processor handler from its injected dependencies. */
export function makeProcessorHandler(deps: ProcessorDeps) {
  return async function handler(event: SqsEvent): Promise<BatchResponse> {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        const msg = parseProcessorMessage(record.body);
        const plan = planProcessing(msg);
        await deps.runInWorkspaceTx(msg.workspace_id, plan);
      } catch {
        // No ack → SQS redrives → DLQ. Never throw out of the handler.
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}
