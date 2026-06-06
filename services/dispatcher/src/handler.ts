// Dispatcher Lambda — thin SQS handler (§9). One record = one outbox id. Per
// record: parse the outbox id (NOT the workspace — that's loaded from the row),
// dispatch it, and map the outcome to ack vs. retry.
//
// Retry policy (CLAUDE.md invariant 4): a 'retryable-failure' adds the record to
// batchItemFailures so SQS redrives it — UNLESS the outbox row's attempts have
// reached MAX_ATTEMPTS, in which case we ack (omit from failures) so it stops
// redriving and the row stays terminal (the redrive policy routes exhausted
// messages to the DLQ). 'send'/'skip'/'refuse'/'defer'/'noop' all ack — the row
// state already reflects the outcome; a malformed body acks-as-failure → DLQ.
import { parseOutboxIdFromSqsRecord } from './core.js';
import { dispatchOutbox, type DispatchDeps } from './dispatch.js';

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

/** Max delivery attempts before we stop redriving and let the row go to DLQ. */
export const MAX_ATTEMPTS = 5;

/** Handler-level deps: the orchestrator deps plus the attempts ceiling. */
export interface HandlerDeps extends DispatchDeps {
  /** Override the redrive ceiling (defaults to MAX_ATTEMPTS). */
  readonly maxAttempts?: number;
}

/** Build the dispatcher handler from its injected dependencies. */
export function makeDispatcherHandler(deps: HandlerDeps) {
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  return async function handler(event: SqsEvent): Promise<BatchResponse> {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      let outboxId: string;
      try {
        outboxId = parseOutboxIdFromSqsRecord(record.body);
      } catch {
        // Malformed body — unprocessable. Report as failure → redrive → DLQ.
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }
      try {
        const outcome = await dispatchOutbox(deps, outboxId);
        if (outcome.result === 'retryable-failure') {
          const attempts = await currentAttempts(deps, outboxId);
          // Bounded by outbox.attempts: once exhausted, ACK so SQS stops
          // redriving (the row is left for the DLQ / manual replay).
          if (attempts < maxAttempts) {
            failures.push({ itemIdentifier: record.messageId });
          }
        }
        // All other outcomes ack (the row already reflects the decision).
      } catch {
        // Defensive: never throw out of the handler. Treat as retryable.
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

/** Read the current attempts for an outbox row (best-effort; 0 on any miss). */
async function currentAttempts(deps: DispatchDeps, outboxId: string): Promise<number> {
  try {
    const { rows } = await deps.reader.query<{ attempts: number }>(
      `SELECT attempts FROM outbox WHERE id = $1`,
      [outboxId],
    );
    return rows[0]?.attempts ?? 0;
  } catch {
    return 0;
  }
}
